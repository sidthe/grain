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

package sqlite_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ai-on-gke/grain/pkg/model"
	"github.com/ai-on-gke/grain/pkg/staterepo"
)

func TestSchema153MigratesAndRoundTripsHeaderIdentity(t *testing.T) {
	t.Parallel()
	store, db, ctx := openStore(t)

	// Verify migration 153 runs cleanly from a schema 152 database that lacks
	// header_color and header_pattern columns.
	if _, err := db.ExecContext(ctx, "ALTER TABLE `grain_config` DROP COLUMN `header_color`"); err != nil {
		t.Fatalf("dropping header_color to simulate schema 152: %v", err)
	}
	if _, err := db.ExecContext(ctx, "ALTER TABLE `grain_config` DROP COLUMN `header_pattern`"); err != nil {
		t.Fatalf("dropping header_pattern to simulate schema 152: %v", err)
	}
	if _, err := db.ExecContext(ctx, "UPDATE `grain_schema` SET `version` = 152 WHERE `id` = 1"); err != nil {
		t.Fatalf("rewinding schema version to 152: %v", err)
	}
	if err := model.New(db).Init(ctx); err != nil {
		t.Fatalf("Init from 152 to %d: %v", model.SchemaVersion, err)
	}
	var ver int
	if err := db.QueryRowContext(ctx, "SELECT `version` FROM `grain_schema` WHERE `id` = 1").Scan(&ver); err != nil {
		t.Fatalf("reading grain_schema.version: %v", err)
	}
	if ver != model.SchemaVersion {
		t.Fatalf("schema version = %d, want %d", ver, model.SchemaVersion)
	}

	// Config round-trip through PutConfig / GetConfig.
	cfg := model.DefaultConfig()
	cfg.EnvironmentName = "prod-eu"
	cfg.HeaderColor = model.HeaderColorTeal
	cfg.HeaderPattern = model.HeaderPatternWaves
	if err := store.PutConfig(ctx, cfg); err != nil {
		t.Fatalf("PutConfig: %v", err)
	}
	got, err := store.GetConfig(ctx)
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	if got.EnvironmentName != "prod-eu" || got.HeaderColor != "teal" || got.HeaderPattern != "waves" {
		t.Fatalf("GetConfig = (%q, %q, %q), want (prod-eu, teal, waves)",
			got.EnvironmentName, got.HeaderColor, got.HeaderPattern)
	}

	// Export to state-repo tables/grain_config.json and verify both columns appear.
	dir := t.TempDir()
	if err := staterepo.Export(ctx, db, dir); err != nil {
		t.Fatalf("staterepo.Export: %v", err)
	}
	cfgPath := filepath.Join(dir, staterepo.TablesDir, "grain_config.json")
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("reading grain_config.json: %v", err)
	}
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("unmarshaling grain_config.json: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("grain_config.json rows = %d, want 1", len(rows))
	}
	if rows[0]["header_color"] != "teal" || rows[0]["header_pattern"] != "waves" {
		t.Fatalf("exported grain_config = (%v, %v), want (teal, waves)",
			rows[0]["header_color"], rows[0]["header_pattern"])
	}

	// Edit exported JSON and import into a fresh store.
	rows[0]["header_color"] = "plum"
	rows[0]["header_pattern"] = "diagonal"
	edited, err := json.MarshalIndent(rows, "", "  ")
	if err != nil {
		t.Fatalf("marshaling edited grain_config.json: %v", err)
	}
	if err := os.WriteFile(cfgPath, edited, 0o600); err != nil {
		t.Fatalf("writing edited grain_config.json: %v", err)
	}

	store2, db2, _ := openStore(t)
	if err := staterepo.Import(ctx, db2, dir); err != nil {
		t.Fatalf("staterepo.Import: %v", err)
	}
	got2, err := store2.GetConfig(ctx)
	if err != nil {
		t.Fatalf("GetConfig after import: %v", err)
	}
	if got2.HeaderColor != "plum" || got2.HeaderPattern != "diagonal" {
		t.Fatalf("imported Config = (%q, %q), want (plum, diagonal)",
			got2.HeaderColor, got2.HeaderPattern)
	}

	// Verify staterepo.Check vocabulary warnings: valid presets stay silent,
	// unrecognized header_color / header_pattern values emit warnings.
	if err := staterepo.WriteSchemaVersion(dir, model.SchemaVersion); err != nil {
		t.Fatalf("WriteSchemaVersion: %v", err)
	}
	_, checkDB, _ := openStore(t)
	validReport, err := staterepo.Check(ctx, checkDB, dir, model.SchemaVersion)
	if err != nil {
		t.Fatalf("staterepo.Check valid: %v", err)
	}
	if joined := strings.Join(validReport.Warnings, "\n"); strings.Contains(joined, "header_color") || strings.Contains(joined, "header_pattern") {
		t.Errorf("valid header presets produced vocabulary warnings: %q", joined)
	}

	rows[0]["header_color"] = "magenta"
	rows[0]["header_pattern"] = "stripes"
	badJSON, err := json.MarshalIndent(rows, "", "  ")
	if err != nil {
		t.Fatalf("marshaling invalid grain_config.json: %v", err)
	}
	if err := os.WriteFile(cfgPath, badJSON, 0o600); err != nil {
		t.Fatalf("writing invalid grain_config.json: %v", err)
	}
	_, badCheckDB, _ := openStore(t)
	badReport, err := staterepo.Check(ctx, badCheckDB, dir, model.SchemaVersion)
	if err != nil {
		t.Fatalf("staterepo.Check invalid: %v", err)
	}
	joinedBad := strings.Join(badReport.Warnings, "\n")
	for _, want := range []string{"header_color", `"magenta"`, "header_pattern", `"stripes"`, "grain_config.json"} {
		if !strings.Contains(joinedBad, want) {
			t.Errorf("staterepo.Check warnings missing %s: %q", want, joinedBad)
		}
	}
}
