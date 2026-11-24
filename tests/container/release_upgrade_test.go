// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package container

// Upgrades from real, published releases onto the build under test
// (design/playbook/releases.playbook.md, section 10).
//
// TestUpgradeFromPreviousVersion's baseline is this checkout's own binary
// relabelled, which proves the upgrade path works and nothing about the
// rows an older build left behind. Under continuous releases a deployment
// following `latest` jumps several minors at once, so Stage 1 of every RC
// (.github/workflows/nightly.yml's upgrade-test) runs the same upgrade from
// two images somebody actually shipped:
//
//	latest: the newest promoted vX.Y.Z below the version under test,
//	which is where every deployment on the `latest` channel is today
//
//	floor: the oldest promoted release of that major at or above
//	RELEASE_FLOOR_MINOR (scripts/release.conf), the longest jump a
//	supported deployment can make in one upgrade
//
// Both are pulled from GRAIN_UPGRADE_RELEASE_IMAGE (the published grain
// image's repository, no tag), and the test skips without it. The
// workflow requires both subtests to PASS, so a skip there is a failure.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ai-on-gke/grain/pkg/installtrack"
	"github.com/ai-on-gke/grain/pkg/upgrade"
)

func TestUpgradeFromReleasedVersions(t *testing.T) {
	releaseImage := strings.TrimSpace(os.Getenv("GRAIN_UPGRADE_RELEASE_IMAGE"))
	if releaseImage == "" {
		t.Skip("GRAIN_UPGRADE_RELEASE_IMAGE is unset; this test needs the published release images to upgrade from")
	}
	requireImage(t)
	requireGoToolchain(t)
	requireGit(t)

	conf := readReleaseConf(t)
	target := strings.TrimSpace(os.Getenv("GRAIN_UPGRADE_TARGET"))
	latest, floor, fromRegistry, err := resolveReleaseBaselines(
		gitTags(t), target, promotedRelease(t), conf,
		func() ([]string, error) {
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			return registryReleaseTags(ctx, releaseImage, target, conf)
		},
	)
	if err != nil {
		t.Fatalf("choosing the releases to upgrade from: %v", err)
	}
	if fromRegistry {
		t.Logf("checkout has no promoted release git tags; chose baselines from %s", releaseImage)
	}
	t.Logf("upgrading %s (target %q) from latest %s and floor %s", image, target, latest, floor)

	current := imageSchemaVersion(t, image)
	for _, baseline := range []struct{ name, tag string }{
		{"latest", latest},
		{"floor", floor},
	} {
		t.Run(baseline.name, func(t *testing.T) {
			ref := releaseImage + ":" + baseline.tag
			if _, err := tryDocker("pull", "--quiet", ref); err != nil {
				if leg, ok := installtrack.LegacyRepositoryFor(releaseImage); ok {
					legRef := leg + ":" + baseline.tag
					if _, legErr := tryDocker("pull", "--quiet", legRef); legErr == nil {
						ref = legRef
					} else {
						t.Fatalf("docker pull %s (and legacy fallback %s): %v (%v)", ref, legRef, err, legErr)
					}
				} else {
					t.Fatalf("docker pull %s: %v", ref, err)
				}
			}
			// Asked, not assumed: an older build may predate the
			// subcommand, and that is not what this test is about.
			if out, err := tryDocker("run", "--rm", ref, "schema-version"); err == nil {
				if from, err := strconv.Atoi(strings.TrimSpace(strings.SplitN(strings.TrimSpace(out), "\n", 2)[0])); err == nil {
					t.Logf("%s is schema %d, the build under test schema %d", baseline.tag, from, current)
					if from > current {
						t.Errorf("%s knows schema %d, ahead of the build under test (%d): migrations are forward-only, "+
							"so a deployment on %s could never take this build", baseline.tag, from, current, baseline.tag)
					}
				}
			}
			// Run it under a name of its own: once the upgrade is done the
			// upgrader removes the images left in the repository the
			// deployment ran from, and the image under test is usually in
			// that same published repository (release.yml's
			// docker.io/grainai/grain:sha-...), so the first subtest would take
			// the second one's upgrade target with it.
			local := "grain-e2e-baseline-" + baseline.name + ":" + randomSuffix(t, 8)
			docker(t, "tag", ref, local)
			t.Cleanup(func() { _, _ = tryDocker("rmi", "--force", local) })
			upgradeFromBaseline(t, baseline.tag, local)
		})
	}
}

// releaseConf is the part of scripts/release.conf the baselines are
// chosen by.
type releaseConf struct {
	major, floorMinor int
	neverPromote      []string
}

func readReleaseConf(t *testing.T) releaseConf {
	t.Helper()
	f, err := os.Open(filepath.Join(repoRoot(t), "scripts", "release.conf"))
	if err != nil {
		t.Fatalf("reading scripts/release.conf: %v", err)
	}
	defer f.Close()
	conf, err := parseReleaseConf(f)
	if err != nil {
		t.Fatalf("scripts/release.conf: %v", err)
	}
	return conf
}

func parseReleaseConf(r io.Reader) (releaseConf, error) {
	var conf releaseConf
	var sawMajor bool
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		key, value, ok := strings.Cut(strings.TrimSpace(scanner.Text()), "=")
		if !ok || strings.HasPrefix(key, "#") {
			continue
		}
		value = strings.Trim(value, `"'`)
		var err error
		switch key {
		case "RELEASE_MAJOR":
			conf.major, err = strconv.Atoi(value)
			sawMajor = true
		case "RELEASE_FLOOR_MINOR":
			conf.floorMinor, err = strconv.Atoi(value)
		case "RELEASE_NEVER_PROMOTE":
			conf.neverPromote = strings.Fields(value)
		}
		if err != nil {
			return conf, fmt.Errorf("%s=%q: %v", key, value, err)
		}
	}
	if !sawMajor {
		return conf, fmt.Errorf("no RELEASE_MAJOR")
	}
	return conf, scanner.Err()
}

func gitTags(t *testing.T) []string {
	t.Helper()
	cmd := exec.Command("git", "tag", "-l", "v*")
	cmd.Dir = repoRoot(t)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("listing release tags: %v\n%s", err, out)
	}
	return strings.Fields(string(out))
}

// promotedRelease is the newest vX.Y.Z the git tag `latest` names: what
// promote.yml publishes as `:latest`, and the newest release whose images
// exist. A release tagged and not yet promoted (a patch cut on
// release/vX.Y.Z, say) has no `:vX.Y.Z` image to pull. Empty when the
// checkout has no `latest` tag.
func promotedRelease(t *testing.T) string {
	t.Helper()
	cmd := exec.Command("git", "tag", "-l", "v*", "--points-at", "latest^{commit}")
	cmd.Dir = repoRoot(t)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	var newest string
	var newestV semver
	for _, tag := range strings.Fields(string(out)) {
		if m := releaseTag.FindStringSubmatch(tag); m != nil {
			if v := parseSemver(m); newest == "" || newestV.less(v) {
				newest, newestV = tag, v
			}
		}
	}
	return newest
}

var (
	releaseTag = regexp.MustCompile(`^v(\d+)\.(\d+)\.(\d+)$`)
	targetTag  = regexp.MustCompile(`^v(\d+)\.(\d+)\.(\d+)(-rc\.\d+)?$`)
)

type semver [3]int

func parseSemver(m []string) semver {
	var v semver
	for i := range v {
		v[i], _ = strconv.Atoi(m[i+1])
	}
	return v
}

func (v semver) less(o semver) bool { return slices.Compare(v[:], o[:]) < 0 }

// releaseBaselines picks the releases to upgrade from out of the
// repository's tags: only promoted vX.Y.Z (no -rc, -pending, -discarded
// or -retracted), none named in RELEASE_NEVER_PROMOTE, none above promoted
// (the release `latest` names, when there is one: anything newer is tagged
// but not yet published), and when target is a version or an RC of one,
// only releases below it. latest is the newest
// of those; floor is the oldest of latest's major at or above
// RELEASE_FLOOR_MINOR when that major is RELEASE_MAJOR (any minor of an
// older major), so the two differ whenever that major has had more than
// one release.
func releaseBaselines(tags []string, target, promoted string, conf releaseConf) (latest, floor string, err error) {
	var bound, ceiling *semver
	if m := targetTag.FindStringSubmatch(target); m != nil {
		v := parseSemver(m)
		bound = &v
	}
	if m := releaseTag.FindStringSubmatch(promoted); m != nil {
		v := parseSemver(m)
		ceiling = &v
	}
	type release struct {
		tag string
		v   semver
	}
	var releases []release
	for _, tag := range tags {
		m := releaseTag.FindStringSubmatch(tag)
		if m == nil || slices.Contains(conf.neverPromote, tag) || slices.Contains(tags, tag+"-retracted") {
			continue
		}
		v := parseSemver(m)
		if bound != nil && !v.less(*bound) {
			continue
		}
		if ceiling != nil && ceiling.less(v) {
			continue
		}
		releases = append(releases, release{tag, v})
	}
	if len(releases) == 0 {
		return "", "", fmt.Errorf("no promoted release below %q among %d tags", target, len(tags))
	}
	slices.SortFunc(releases, func(a, b release) int { return slices.Compare(a.v[:], b.v[:]) })
	newest := releases[len(releases)-1]
	minMinor := 0
	if newest.v[0] == conf.major {
		minMinor = conf.floorMinor
	}
	for _, r := range releases {
		if r.v[0] == newest.v[0] && r.v[1] >= minMinor {
			return newest.tag, r.tag, nil
		}
	}
	// Every release of this major is below the floor, which only a floor
	// raised past the newest release can do: the newest is all there is.
	return newest.tag, newest.tag, nil
}

// resolveReleaseBaselines selects latest and floor from local git tags when
// the checkout has at least one promoted release tag, and falls back to
// listing published tags from the release image repository when it does not
// (for example on a fork that carries main without mirroring upstream's
// release git tags).
func resolveReleaseBaselines(tags []string, target, promoted string, conf releaseConf, listRegistry func() ([]string, error)) (latest, floor string, fromRegistry bool, err error) {
	latest, floor, err = releaseBaselines(tags, target, promoted, conf)
	if err == nil || listRegistry == nil {
		return latest, floor, false, err
	}
	regTags, regErr := listRegistry()
	if regErr != nil {
		return "", "", false, fmt.Errorf("%w (registry tag fallback failed: %v)", err, regErr)
	}
	// Only promoted releases carry :vX.Y.Z in the image registry, so there is
	// no unpromoted-git-tag ceiling to apply when selecting from registry tags.
	latest, floor, regBaseErr := releaseBaselines(regTags, target, "", conf)
	if regBaseErr != nil {
		return "", "", false, fmt.Errorf("%w (registry fallback: %v)", err, regBaseErr)
	}
	return latest, floor, true, nil
}

// registryReleaseTags lists published tags from releaseImage and, when
// installtrack.LegacyRepositoryFor maps it to a pre-cutover legacy repository,
// merges the deduplicated tags from both repositories so releaseBaselines sees
// the full release history (including pre-cutover floor releases and
// -retracted markers from either repository).
func registryReleaseTags(ctx context.Context, releaseImage, target string, conf releaseConf) ([]string, error) {
	leg, hasLeg := installtrack.LegacyRepositoryFor(releaseImage)
	return listReleaseTagsFromRepos(ctx, releaseImage, leg, hasLeg, target, conf, upgrade.ListRegistryTags)
}

func listReleaseTagsFromRepos(
	ctx context.Context,
	primary, legacy string,
	hasLegacy bool,
	target string,
	conf releaseConf,
	list func(context.Context, string) ([]string, error),
) ([]string, error) {
	primaryTags, primaryErr := list(ctx, primary)
	if !hasLegacy {
		return primaryTags, primaryErr
	}
	legacyTags, legacyErr := list(ctx, legacy)
	switch {
	case primaryErr == nil && legacyErr == nil:
		return mergeUniqueTags(primaryTags, legacyTags), nil
	case primaryErr != nil && legacyErr != nil:
		return nil, fmt.Errorf("listing %s: %v; listing legacy %s: %v", primary, primaryErr, legacy, legacyErr)
	case primaryErr == nil:
		// Treat a legacy-repository lookup failure as best-effort only when
		// primary already covers the expected floor minor; otherwise surface
		// legacyErr so tagless checkouts never silently shift floor forward
		// across the GHCR -> Docker Hub cutover or hide a lookup error.
		if hasFloorBaseline(primaryTags, target, conf) {
			return primaryTags, nil
		}
		if _, _, baseErr := releaseBaselines(primaryTags, target, "", conf); baseErr != nil {
			return nil, fmt.Errorf("%s (%v); listing legacy %s failed: %w", primary, baseErr, legacy, legacyErr)
		}
		return nil, fmt.Errorf("%s does not include the floor minor release and listing legacy %s failed: %w", primary, legacy, legacyErr)
	default:
		if _, _, baseErr := releaseBaselines(legacyTags, target, "", conf); baseErr == nil {
			return legacyTags, nil
		} else {
			return nil, fmt.Errorf("listing %s: %v; legacy %s: %v", primary, primaryErr, legacy, baseErr)
		}
	}
}

func mergeUniqueTags(lists ...[]string) []string {
	seen := make(map[string]struct{})
	var merged []string
	for _, list := range lists {
		for _, tag := range list {
			if _, ok := seen[tag]; ok {
				continue
			}
			seen[tag] = struct{}{}
			merged = append(merged, tag)
		}
	}
	return merged
}

func hasFloorBaseline(tags []string, target string, conf releaseConf) bool {
	latest, floor, err := releaseBaselines(tags, target, "", conf)
	if err != nil {
		return false
	}
	lm := releaseTag.FindStringSubmatch(latest)
	fm := releaseTag.FindStringSubmatch(floor)
	if lm == nil || fm == nil {
		return false
	}
	lv, fv := parseSemver(lm), parseSemver(fm)
	wantMinor := 0
	if lv[0] == conf.major {
		wantMinor = conf.floorMinor
	}
	return fv[0] == lv[0] && fv[1] == wantMinor
}

func TestReleaseBaselines(t *testing.T) {
	conf := releaseConf{major: 3, floorMinor: 0, neverPromote: []string{"v2.5.0", "v3.2.0"}}
	tags := []string{
		"v2.4.0", "v2.5.0", "v3.0.0", "v3.0.1", "v3.1.0", "v3.1.0-rc.1", "v3.1.0-pending",
		"v3.2.0", "v3.3.0-rc.1", "v3.3.0-rc.1-discarded", "v3.3.0-rc.2", "latest", "candidate",
	}
	cases := []struct {
		name, target, latest, floor string
		promoted                    string
		conf                        *releaseConf
		tags                        []string
	}{
		{name: "an RC upgrades from the release before it", target: "v3.3.0-rc.2", latest: "v3.1.0", floor: "v3.0.0"},
		{name: "a hotfix RC from its own minor", target: "v3.1.1-rc.1", latest: "v3.1.0", floor: "v3.0.0"},
		{name: "never-promoted releases are no baseline", target: "", latest: "v3.1.0", floor: "v3.0.0"},
		{name: "a branch name is no bound", target: "main", latest: "v3.1.0", floor: "v3.0.0"},
		{name: "the floor follows RELEASE_FLOOR_MINOR", target: "v3.3.0-rc.1",
			latest: "v3.2.0", floor: "v3.1.0", conf: &releaseConf{major: 3, floorMinor: 1}},
		{name: "the first release of a major falls back to the previous major", target: "v3.0.0-rc.1",
			latest: "v2.4.0", floor: "v2.4.0", conf: &releaseConf{major: 3, neverPromote: []string{"v2.5.0"}}},
		{name: "a release tagged above latest is not yet published", target: "", promoted: "v3.0.1",
			latest: "v3.0.1", floor: "v3.0.0"},
		{name: "no latest tag is no ceiling", target: "main", promoted: "", latest: "v3.1.0", floor: "v3.0.0"},
		{name: "retracted releases are excluded", target: "", promoted: "",
			tags: []string{"v3.0.0", "v3.1.0", "v3.1.0-retracted"}, latest: "v3.0.0", floor: "v3.0.0"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := conf
			if tc.conf != nil {
				c = *tc.conf
			}
			in := tags
			if tc.tags != nil {
				in = tc.tags
			}
			latest, floor, err := releaseBaselines(in, tc.target, tc.promoted, c)
			if err != nil {
				t.Fatal(err)
			}
			if latest != tc.latest || floor != tc.floor {
				t.Errorf("releaseBaselines(%q) = %s, %s; want %s, %s", tc.target, latest, floor, tc.latest, tc.floor)
			}
		})
	}
	if _, _, err := releaseBaselines([]string{"v3.0.0-rc.1"}, "", "", conf); err == nil {
		t.Errorf("releaseBaselines with no promoted release chose one")
	}
}

func TestResolveReleaseBaselines(t *testing.T) {
	conf := releaseConf{major: 3, floorMinor: 0, neverPromote: []string{"v2.5.0"}}

	t.Run("prefers git tags without calling registry", func(t *testing.T) {
		called := false
		latest, floor, fromReg, err := resolveReleaseBaselines(
			[]string{"v3.0.0", "v3.1.0"}, "", "v3.1.0", conf,
			func() ([]string, error) {
				called = true
				return nil, errors.New("unexpected registry call")
			},
		)
		if err != nil {
			t.Fatal(err)
		}
		if called || fromReg || latest != "v3.1.0" || floor != "v3.0.0" {
			t.Fatalf("got (%s, %s, fromReg=%v, called=%v), want (v3.1.0, v3.0.0, false, false)", latest, floor, fromReg, called)
		}
	})

	t.Run("falls back to registry tags when checkout has no git tags", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/v2/grainai/grain/tags/list" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"name":"grainai/grain","tags":["latest","main","sha-deadbeef","v3.4.0","v3.12.0","v3.13.0","v3.14.0","v3.14.0-retracted","v3.15.0-rc.1"]}`))
		}))
		defer srv.Close()

		repo := strings.TrimPrefix(srv.URL, "http://") + "/grainai/grain"
		latest, floor, fromReg, err := resolveReleaseBaselines(nil, "", "", conf, func() ([]string, error) {
			return registryReleaseTags(context.Background(), repo, "", conf)
		})
		if err != nil {
			t.Fatal(err)
		}
		if !fromReg || latest != "v3.13.0" || floor != "v3.4.0" {
			t.Fatalf("got (%s, %s, fromReg=%v), want (v3.13.0, v3.4.0, true)", latest, floor, fromReg)
		}
	})

	t.Run("respects target bound on registry fallback", func(t *testing.T) {
		latest, floor, fromReg, err := resolveReleaseBaselines(
			[]string{"v3.14.0-rc.1"}, "v3.14.0-rc.1", "", conf,
			func() ([]string, error) {
				return []string{"v3.4.0", "v3.13.0", "v3.14.0"}, nil
			},
		)
		if err != nil {
			t.Fatal(err)
		}
		if !fromReg || latest != "v3.13.0" || floor != "v3.4.0" {
			t.Fatalf("got (%s, %s, fromReg=%v), want (v3.13.0, v3.4.0, true)", latest, floor, fromReg)
		}
	})

	t.Run("reports registry failure when git tags are absent", func(t *testing.T) {
		_, _, _, err := resolveReleaseBaselines(nil, "", "", conf, func() ([]string, error) {
			return nil, errors.New("registry unreachable")
		})
		if err == nil || !strings.Contains(err.Error(), "registry unreachable") {
			t.Fatalf("err = %v, want registry unreachable", err)
		}
	})

	t.Run("merges primary and legacy repository tags across cutover", func(t *testing.T) {
		const primary = "docker.io/grainai/grain"
		const legacy = "ghcr.io/bwsalmon/grain/grain"
		if got, ok := installtrack.LegacyRepositoryFor(primary); !ok || got != legacy {
			t.Fatalf("LegacyRepositoryFor(%q) = (%q, %v), want (%q, true)", primary, got, ok, legacy)
		}
		list := func(_ context.Context, repo string) ([]string, error) {
			switch repo {
			case primary:
				return []string{"latest", "v3.5.0", "v3.13.0", "v3.14.0"}, nil
			case legacy:
				return []string{"v3.0.0", "v3.1.0", "v3.5.0", "v3.14.0-retracted"}, nil
			default:
				return nil, fmt.Errorf("unexpected repo %s", repo)
			}
		}
		latest, floor, fromReg, err := resolveReleaseBaselines(nil, "", "", conf, func() ([]string, error) {
			return listReleaseTagsFromRepos(context.Background(), primary, legacy, true, "", conf, list)
		})
		if err != nil {
			t.Fatal(err)
		}
		if !fromReg || latest != "v3.13.0" || floor != "v3.0.0" {
			t.Fatalf("got (%s, %s, fromReg=%v), want (v3.13.0, v3.0.0, true)", latest, floor, fromReg)
		}
	})

	t.Run("surfaces legacy lookup failure when primary lacks floor minor", func(t *testing.T) {
		list := func(_ context.Context, repo string) ([]string, error) {
			if repo == "docker.io/grainai/grain" {
				return []string{"v3.5.0", "v3.13.0"}, nil
			}
			return nil, errors.New("ghcr rate limited")
		}
		_, _, _, err := resolveReleaseBaselines(nil, "", "", conf, func() ([]string, error) {
			return listReleaseTagsFromRepos(context.Background(), "docker.io/grainai/grain", "ghcr.io/bwsalmon/grain/grain", true, "", conf, list)
		})
		if err == nil || !strings.Contains(err.Error(), "ghcr rate limited") {
			t.Fatalf("err = %v, want legacy lookup error surfaced", err)
		}
	})

	t.Run("tolerates legacy lookup failure when primary already includes floor minor", func(t *testing.T) {
		list := func(_ context.Context, repo string) ([]string, error) {
			if repo == "docker.io/grainai/grain" {
				return []string{"v3.0.0", "v3.13.0"}, nil
			}
			return nil, errors.New("ghcr retired")
		}
		latest, floor, fromReg, err := resolveReleaseBaselines(nil, "", "", conf, func() ([]string, error) {
			return listReleaseTagsFromRepos(context.Background(), "docker.io/grainai/grain", "ghcr.io/bwsalmon/grain/grain", true, "", conf, list)
		})
		if err != nil {
			t.Fatal(err)
		}
		if !fromReg || latest != "v3.13.0" || floor != "v3.0.0" {
			t.Fatalf("got (%s, %s, fromReg=%v), want (v3.13.0, v3.0.0, true)", latest, floor, fromReg)
		}
	})

	t.Run("surfaces both errors when primary has no baseline and legacy lookup fails", func(t *testing.T) {
		list := func(_ context.Context, repo string) ([]string, error) {
			if repo == "docker.io/grainai/grain" {
				return []string{"main", "sha-abc1234"}, nil
			}
			return nil, errors.New("ghcr unavailable")
		}
		_, _, _, err := resolveReleaseBaselines(nil, "", "", conf, func() ([]string, error) {
			return listReleaseTagsFromRepos(context.Background(), "docker.io/grainai/grain", "ghcr.io/bwsalmon/grain/grain", true, "", conf, list)
		})
		if err == nil || !strings.Contains(err.Error(), "ghcr unavailable") {
			t.Fatalf("err = %v, want ghcr unavailable", err)
		}
	})

	t.Run("surfaces both errors when both primary and legacy lookups fail", func(t *testing.T) {
		list := func(_ context.Context, repo string) ([]string, error) {
			if repo == "docker.io/grainai/grain" {
				return nil, errors.New("docker hub down")
			}
			return nil, errors.New("ghcr down")
		}
		_, _, _, err := resolveReleaseBaselines(nil, "", "", conf, func() ([]string, error) {
			return listReleaseTagsFromRepos(context.Background(), "docker.io/grainai/grain", "ghcr.io/bwsalmon/grain/grain", true, "", conf, list)
		})
		if err == nil || !strings.Contains(err.Error(), "docker hub down") || !strings.Contains(err.Error(), "ghcr down") {
			t.Fatalf("err = %v, want both docker hub down and ghcr down", err)
		}
	})
}
