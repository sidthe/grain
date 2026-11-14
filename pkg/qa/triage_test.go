package qa

import (
	"testing"
)

func TestEvaluateTriage(t *testing.T) {
	tests := []struct {
		name         string
		in           TriageInput
		wantDecision TriageDecision
		wantBlocked  bool
		wantEnforced bool
	}{
		{
			name: "t0 auto merge",
			in: TriageInput{
				Mode:                     "enforced",
				Assessment:               RiskAssessment{Tier: BlastT0},
				OperatorAutoMergeEnabled: true,
			},
			wantDecision: TriageAutoMerge,
		},
		{
			name: "t2 require human",
			in: TriageInput{
				Mode:                     "enforced",
				Assessment:               RiskAssessment{Tier: BlastT2},
				OperatorAutoMergeEnabled: true,
			},
			wantDecision: TriageRequireHuman,
			wantEnforced: true,
		},
		{
			name: "trust boundary blocks all",
			in: TriageInput{
				Mode:                     "enforced",
				AutoMergeTiers:           []BlastTier{BlastT0, BlastT1, BlastT2, BlastT3},
				Assessment:               RiskAssessment{Tier: BlastT0, TrustBoundaryHit: true},
				OperatorAutoMergeEnabled: true,
			},
			wantDecision: TriageRequireHuman,
			wantBlocked:  true,
			wantEnforced: false,
		},
		{
			name: "files truncated blocks",
			in: TriageInput{
				Mode:                     "enforced",
				AutoMergeTiers:           []BlastTier{BlastT0, BlastT1, BlastT2, BlastT3},
				Assessment:               RiskAssessment{Tier: BlastT0},
				FilesTruncated:           true,
				OperatorAutoMergeEnabled: true,
			},
			wantDecision: TriageRequireHuman,
			wantBlocked:  true,
		},
		{
			name: "operator auto merge disabled blocks",
			in: TriageInput{
				Mode:                     "enforced",
				Assessment:               RiskAssessment{Tier: BlastT0},
				OperatorAutoMergeEnabled: false,
			},
			wantDecision: TriageRequireHuman,
			wantBlocked:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := EvaluateTriage(tt.in, dummyProfiler{})
			if got.Decision != tt.wantDecision {
				t.Errorf("got decision %v want %v", got.Decision, tt.wantDecision)
			}
			if got.BlockedByFloor != tt.wantBlocked {
				t.Errorf("got blocked %v want %v", got.BlockedByFloor, tt.wantBlocked)
			}
			if got.Enforced != tt.wantEnforced {
				t.Errorf("got enforced %v want %v", got.Enforced, tt.wantEnforced)
			}
		})
	}
}
