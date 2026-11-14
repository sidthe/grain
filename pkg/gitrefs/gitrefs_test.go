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

package gitrefs_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ai-on-gke/grain/pkg/gitrefs"
)

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

func TestFormatReadsTheConfigOfEveryRepositoryShape(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()

	work := filepath.Join(root, "work")
	git(t, root, "init", "-q", work)
	git(t, work, "-c", "user.name=a", "-c", "user.email=a@b", "commit", "-q", "--allow-empty", "-m", "x")
	bare := filepath.Join(root, "bare.git")
	git(t, root, "init", "-q", "--bare", bare)
	linked := filepath.Join(root, "linked")
	git(t, work, "-c", "user.name=a", "-c", "user.email=a@b", "worktree", "add", "-q", linked)
	plain := filepath.Join(root, "plain")
	if err := os.Mkdir(plain, 0o755); err != nil {
		t.Fatal(err)
	}

	for _, dir := range []string{work, bare, linked, plain} {
		if got, err := gitrefs.Format(ctx, dir); err != nil || got != "" {
			t.Errorf("Format(%s) = %q, %v; want \"\", nil", dir, got, err)
		}
	}
	git(t, work, "config", "extensions.refStorage", "Reftable")
	git(t, bare, "config", "extensions.refstorage", "reftable")
	for _, dir := range []string{work, bare, linked} {
		if got, err := gitrefs.Format(ctx, dir); err != nil || got != "reftable" {
			t.Errorf("Format(%s) = %q, %v; want reftable", dir, got, err)
		}
	}
}

func TestCheckLeavesAFilesRepositoryAlone(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-q")
	if err := gitrefs.Check(context.Background(), dir); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "config", "extensions.refstorage", "files")
	if err := gitrefs.Check(context.Background(), dir); err != nil {
		t.Fatal(err)
	}
	if err := gitrefs.Check(context.Background(), t.TempDir()); err != nil {
		t.Fatalf("a directory with no repository: %v", err)
	}
}

func TestTheConversionCommandIsQuotedForAShell(t *testing.T) {
	err := &gitrefs.UnreadableError{Dir: "/var/lib/grain/it's here", Format: "reftable"}
	want := `git -C '/var/lib/grain/it'\''s here' refs migrate --ref-format=files`
	if msg := err.Error(); !strings.Contains(msg, want) {
		t.Fatalf("the message does not offer %q:\n%s", want, msg)
	}
}

func TestParseRefNameValid(t *testing.T) {
	cases := []struct {
		ref  string
		want string
	}{
		{ref: "refs/heads/main", want: "heads/main"},
		{ref: "refs/tags/v1.2.3", want: "tags/v1.2.3"},
		{ref: "refs/pull/454/head", want: "pull/454/head"},
		{ref: "refs/remotes/origin/main", want: "remotes/origin/main"},
		{ref: "refs/a", want: "a"},
		{ref: "refs/heads/a.b", want: "heads/a.b"},
		{ref: "refs/heads/feat/foo-bar_1", want: "heads/feat/foo-bar_1"},
		{ref: "refs/refs/heads/main", want: "refs/heads/main"},
	}
	for _, tc := range cases {
		got, err := gitrefs.ParseRefName(tc.ref)
		if err != nil {
			t.Errorf("ParseRefName(%q) unexpected error: %v", tc.ref, err)
			continue
		}
		if got != tc.want {
			t.Errorf("ParseRefName(%q) = %q, want %q", tc.ref, got, tc.want)
		}
	}
}

func TestParseRefNameInvalid(t *testing.T) {
	cases := []struct {
		name string
		ref  string
	}{
		{name: "empty", ref: ""},
		{name: "empty_after_prefix", ref: "refs/"},
		{name: "no_slash", ref: "refs"},
		{name: "missing_prefix", ref: "heads/main"},
		{name: "bare_branch", ref: "main"},
		{name: "head", ref: "HEAD"},
		{name: "uppercase_prefix", ref: "REFS/heads/main"},
		{name: "leading_space", ref: " refs/heads/main"},
		{name: "leading_slash", ref: "/refs/heads/main"},
		{name: "backslash_prefix", ref: `refs\heads\main`},
		{name: "only_nul", ref: "\x00"},
		{name: "nul_after_prefix", ref: "refs/\x00"},
		{name: "trailing_nul", ref: "refs/heads/main\x00"},
		{name: "middle_nul", ref: "refs/heads/a\x00b"},
		{name: "leading_nul", ref: "\x00refs/heads/main"},
		{name: "only_dotdot", ref: ".."},
		{name: "dotdot_after_prefix", ref: "refs/.."},
		{name: "dotdot_component", ref: "refs/../heads/main"},
		{name: "trailing_dotdot_component", ref: "refs/heads/.."},
		{name: "inline_dotdot", ref: "refs/heads/a..b"},
		{name: "triple_dot", ref: "refs/heads/..."},
		{name: "dotdot_prefix_name", ref: "refs/..a"},
		{name: "dotdot_suffix_name", ref: "refs/a.."},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := gitrefs.ParseRefName(tc.ref)
			if err == nil {
				t.Fatalf("ParseRefName(%q) = %q, nil; want error", tc.ref, got)
			}
			if got != "" {
				t.Fatalf("ParseRefName(%q) returned non-empty name %q alongside error %v", tc.ref, got, err)
			}
		})
	}
}

func TestParseRefNameHugeInputs(t *testing.T) {
	huge := strings.Repeat("a", 1<<20)

	got, err := gitrefs.ParseRefName("refs/heads/" + huge)
	if err != nil {
		t.Fatalf("ParseRefName(huge valid) unexpected error: %v", err)
	}
	want := "heads/" + huge
	if got != want {
		t.Fatalf("ParseRefName(huge valid) len=%d, want len=%d", len(got), len(want))
	}

	invalid := []string{
		"refs/heads/" + huge + "..",
		"refs/heads/" + huge + "\x00",
		huge,
	}
	for i, ref := range invalid {
		got, err := gitrefs.ParseRefName(ref)
		if err == nil {
			t.Fatalf("invalid[%d] unexpectedly succeeded with len=%d", i, len(got))
		}
		if got != "" {
			t.Fatalf("invalid[%d] returned non-empty name alongside error %v", i, err)
		}
		if len(err.Error()) >= 256 {
			t.Fatalf("invalid[%d] error message unexpectedly large (%d bytes)", i, len(err.Error()))
		}
	}
}
