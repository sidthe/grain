package expstats

import (
	"testing"
)

func TestEvaluateTriageHarmBreaker(t *testing.T) {
	tests := []struct {
		name        string
		refObs      []TriageObservation
		candObs     []TriageObservation
		wantTripped bool
	}{
		{
			name:        "empty",
			refObs:      []TriageObservation{},
			candObs:     []TriageObservation{},
			wantTripped: false,
		},
		{
			name: "benign parity",
			refObs: []TriageObservation{
				{Decision: "auto_merge", Escaped: false},
				{Decision: "auto_merge", Escaped: true},
			},
			candObs: []TriageObservation{
				{Decision: "auto_merge", Escaped: false}, {Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: false}, {Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: false}, {Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: false}, {Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: false}, {Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: false}, {Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: false}, {Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: false}, {Decision: "auto_merge", Escaped: true},
			},
			wantTripped: false,
		},
		{
			name: "synthetic escape spike",
			refObs: []TriageObservation{
				{Decision: "auto_merge", Escaped: false},
				{Decision: "auto_merge", Escaped: false},
				{Decision: "auto_merge", Escaped: false},
				{Decision: "auto_merge", Escaped: false},
				{Decision: "auto_merge", Escaped: false},
			},
			candObs: []TriageObservation{
				{Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: true},
				{Decision: "auto_merge", Escaped: true},
			},
			wantTripped: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := EvaluateTriageHarmBreaker(tt.refObs, tt.candObs, 0.01, 15)
			if got.Tripped != tt.wantTripped {
				t.Errorf("got tripped %v want %v (pvalue=%v delta=%v)", got.Tripped, tt.wantTripped, got.PValue, got.DeltaEscapeRate)
			}
		})
	}
}
