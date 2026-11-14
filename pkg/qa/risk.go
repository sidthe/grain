package qa

import (
	"fmt"
	"path"
	"strings"

	"github.com/ai-on-gke/grain/pkg/trustboundary"
)

type BlastTier string

const (
	BlastT0 BlastTier = "T0"
	BlastT1 BlastTier = "T1"
	BlastT2 BlastTier = "T2"
	BlastT3 BlastTier = "T3"
)

func (t BlastTier) Rank() int {
	switch t {
	case BlastT0:
		return 0
	case BlastT1:
		return 1
	case BlastT2:
		return 2
	case BlastT3:
		return 3
	default:
		return -1
	}
}

func MaxBlastTier(a, b BlastTier) BlastTier {
	if a.Rank() >= b.Rank() {
		return a
	}
	return b
}

func (t BlastTier) RequiresS4() bool {
	return t == BlastT2 || t == BlastT3
}

type DiffStats struct {
	Files                 []string
	NonTestAdded          int
	NonTestDeleted        int
	SiblingCallerPackages int
	TestTampered          bool
}

type RiskOverride struct {
	Paths   []string
	MinTier BlastTier
	Reason  string
}

type RiskAssessment struct {
	Tier             BlastTier
	Score            int
	Reasons          []string
	TrustBoundaryHit bool
	TestTampered     bool
}

func ClassifyDiffBlast(stats DiffStats) (BlastTier, []string) {
	out := AssessDiffBlast(stats, nil, nil)
	return out.Tier, out.Reasons
}

func AssessDiffBlast(stats DiffStats, overrides []RiskOverride, prof perfProfiler) RiskAssessment {
	var out RiskAssessment
	fn := func() (string, error) {
		out = assessDiffBlastInternal(stats, overrides)
		return string(out.Tier), nil
	}
	if prof != nil {
		prof.Measure(PerfSample{Stage: "assess-blast", CheckID: "risk"}, fn)
	} else {
		fn()
	}
	return out
}

func assessDiffBlastInternal(stats DiffStats, overrides []RiskOverride) RiskAssessment {
	if len(stats.Files) == 0 {
		return RiskAssessment{Tier: BlastT0, Score: 0, Reasons: []string{"empty diff"}}
	}

	var normalized []string
	allDocsOrTests := true
	touchesT2Surface := false
	trustBoundaryHit := false
	var reasons []string

	score := 0

	for _, raw := range stats.Files {
		f := strings.TrimPrefix(path.Clean(strings.TrimSpace(raw)), "./")
		if f == "" || f == "." {
			continue
		}
		normalized = append(normalized, f)

		if !isDocOrTestFile(f) {
			allDocsOrTests = false
		}

		switch {
		case strings.HasPrefix(f, "pkg/qa/"), f == "pkg/qa":
			trustBoundaryHit = true
		}
	}

	if tbMatches := trustboundary.Classify(normalized); len(tbMatches) > 0 {
		trustBoundaryHit = true
		for _, m := range tbMatches {
			reasons = append(reasons, fmt.Sprintf("trust boundary (%s)", m.Category.ID))
		}
	} else if trustBoundaryHit {
		reasons = append(reasons, "touches quality control engine")
	}

	if trustBoundaryHit {
		score += 85
	}

	if stats.TestTampered {
		score += 50
		reasons = append(reasons, "test tampered")
	}

	if stats.SiblingCallerPackages > 0 {
		if stats.SiblingCallerPackages == 1 {
			score += 15
			reasons = append(reasons, "1 sibling caller")
		} else if stats.SiblingCallerPackages <= 4 {
			score += 35
			touchesT2Surface = true
			reasons = append(reasons, fmt.Sprintf("modified export referenced by %d sibling packages", stats.SiblingCallerPackages))
		} else if stats.SiblingCallerPackages <= 9 {
			score += 55
			touchesT2Surface = true
			reasons = append(reasons, fmt.Sprintf("modified export referenced by %d sibling packages", stats.SiblingCallerPackages))
		} else {
			score += 65
			reasons = append(reasons, fmt.Sprintf("modified export referenced by %d sibling packages", stats.SiblingCallerPackages))
		}
	}

	hasSchema := false
	hasMigrations := false

	for _, f := range normalized {
		if strings.HasPrefix(f, "pkg/staterepo/") || strings.HasPrefix(f, "pkg/declschema/") || f == "route_scopes.go" {
			hasSchema = true
		}
		if f == "pkg/model/schema.go" {
			hasSchema = true
		}
		if f == "pkg/model/migrations.go" {
			hasMigrations = true
		}
	}

	if hasSchema || hasMigrations {
		score += 40
		touchesT2Surface = true
		reasons = append(reasons, "schema/config surface")
	}

	nonTestChurn := stats.NonTestAdded + stats.NonTestDeleted
	if hasSchema && hasMigrations && nonTestChurn > 50 {
		score += 75
		reasons = append(reasons, "schema and migrations heavily modified")
	}

	for _, f := range normalized {
		if strings.HasPrefix(f, "ui/") || strings.HasPrefix(f, "ui-ng/") {
			if !isTestFile(f) {
				score += 30
				touchesT2Surface = true
				reasons = append(reasons, "UI surface")
				break
			}
		}
	}

	if nonTestChurn > 0 {
		if nonTestChurn <= 40 {
			score += 5
		} else if nonTestChurn <= 250 {
			score += 15
		} else if nonTestChurn <= 600 {
			score += 35
			touchesT2Surface = true
		} else {
			score += 55
			touchesT2Surface = true
		}
		reasons = append(reasons, fmt.Sprintf("%d non-test lines changed", nonTestChurn))
	}

	if score > 100 {
		score = 100
	}

	var baseTier BlastTier
	if allDocsOrTests && nonTestChurn == 0 && score <= 10 {
		baseTier = BlastT0
	} else if score <= 29 {
		baseTier = BlastT1
	} else if score <= 74 {
		baseTier = BlastT2
	} else {
		baseTier = BlastT3
	}

	if trustBoundaryHit {
		baseTier = MaxBlastTier(baseTier, BlastT3)
		if score < 85 {
			score = 85
		}
	}
	if stats.TestTampered {
		baseTier = MaxBlastTier(baseTier, BlastT3)
	}
	if touchesT2Surface {
		baseTier = MaxBlastTier(baseTier, BlastT2)
	}
	if hasSchema && hasMigrations && nonTestChurn > 50 {
		baseTier = MaxBlastTier(baseTier, BlastT3)
	}
	if stats.SiblingCallerPackages >= 10 {
		baseTier = MaxBlastTier(baseTier, BlastT3)
	}

	for _, ov := range overrides {
		matched := false
		for _, fp := range normalized {
			for _, pat := range ov.Paths {
				if matchedGlob(pat, fp) {
					matched = true
					break
				}
			}
			if matched {
				break
			}
		}
		if matched {
			baseTier = MaxBlastTier(baseTier, ov.MinTier)
			reasons = append(reasons, ov.Reason)
		}
	}

	if baseTier == BlastT1 && score < 15 {
		score = 15
	} else if baseTier == BlastT2 && score < 35 {
		score = 35
	} else if baseTier == BlastT3 && score < 75 {
		score = 75
	}

	return RiskAssessment{
		Tier:             baseTier,
		Score:            score,
		Reasons:          reasons,
		TrustBoundaryHit: trustBoundaryHit,
		TestTampered:     stats.TestTampered,
	}
}

func matchedGlob(pattern, name string) bool {
	matched, err := path.Match(pattern, name)
	if err != nil {
		return false
	}
	if matched {
		return true
	}
	if strings.Contains(pattern, "**") {
		prefix := strings.Split(pattern, "**")[0]
		return strings.HasPrefix(name, prefix)
	}
	return false
}

func isTestFile(p string) bool {
	return strings.HasSuffix(p, "_test.go") ||
		strings.HasSuffix(p, ".spec.ts") ||
		strings.HasSuffix(p, ".spec.js") ||
		strings.HasSuffix(p, ".test.ts") ||
		strings.HasSuffix(p, ".test.js")
}

func isDocOrTestFile(p string) bool {
	if isTestFile(p) {
		return true
	}
	lower := strings.ToLower(p)
	return strings.HasSuffix(lower, ".md") ||
		strings.HasPrefix(lower, "docs/") ||
		strings.HasPrefix(lower, "design/")
}
