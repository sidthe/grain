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

package checks

import (
	"context"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"strings"

	"github.com/ai-on-gke/grain/pkg/qa"
)

var defaultStrictDecoderKeywords = []string{
	"config", "decl", "schema", "staterepo", "settings", "manifest",
	"policy", "workflow", "qa", ".grain", "spec", "loader",
}

// CheckStrictConfigDecoder enforces golden:strict-config-decoder on modified non-test Go files:
// any yaml.NewDecoder(...) or json.NewDecoder(...) added or touched in a configuration, declaration,
// schema, state, or YAML-loading file must enable KnownFields(true) or DisallowUnknownFields()
// unless annotated with `// qa:allow-unknown-fields <reason>`.
func CheckStrictConfigDecoder(ctx context.Context, ws WorkspaceReader, pd ParsedDiff, extraPaths []string) ([]Finding, error) {
	var findings []Finding

	for _, df := range pd.Files {
		if df.IsDeleted {
			continue
		}
		p := df.EffectivePath()
		if !strings.HasSuffix(p, ".go") || isTestPath(p) {
			continue
		}
		headBytes, err := ws.ReadFileAtHead(ctx, p)
		if err != nil {
			continue
		}
		headText := string(headBytes)
		if strings.Contains(headText, "qa:allow-unknown-fields") && !strings.Contains(headText, "NewDecoder") && !strings.Contains(headText, "Unmarshal") {
			continue
		}

		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, p, headBytes, parser.ParseComments)
		if err != nil {
			continue
		}
		if !isConfigDecoderTarget(p, f, extraPaths) {
			continue
		}

		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			fnStart := fset.Position(fn.Pos()).Line
			fnEnd := fset.Position(fn.End()).Line
			if fnHasAllowComment(f.Comments, fset, fnStart, fnEnd) {
				continue
			}

			type decoderSite struct {
				ident string
				line  int
				pkg   string
				kind  string // "NewDecoder" or "Unmarshal"
			}
			var sites []decoderSite
			assignedCallPos := map[token.Pos]bool{}
			strictVars := map[string]bool{}

			ast.Inspect(fn.Body, func(n ast.Node) bool {
				switch node := n.(type) {
				case *ast.AssignStmt:
					for i, rhs := range node.Rhs {
						call, ok := rhs.(*ast.CallExpr)
						if !ok {
							continue
						}
						sel, ok := call.Fun.(*ast.SelectorExpr)
						if !ok || sel.Sel.Name != "NewDecoder" {
							continue
						}
						pkgIdent, ok := sel.X.(*ast.Ident)
						if !ok || (pkgIdent.Name != "yaml" && pkgIdent.Name != "json") {
							continue
						}
						line := fset.Position(call.Pos()).Line
						if df.IsNew || lineInHunks(line, df.Hunks, 3) {
							varName := ""
							if i < len(node.Lhs) {
								if lhsID, ok := node.Lhs[i].(*ast.Ident); ok && lhsID.Name != "_" {
									varName = lhsID.Name
								}
							}
							assignedCallPos[call.Pos()] = true
							sites = append(sites, decoderSite{ident: varName, line: line, pkg: pkgIdent.Name, kind: "NewDecoder"})
						}
					}
				case *ast.ValueSpec:
					for i, rhs := range node.Values {
						call, ok := rhs.(*ast.CallExpr)
						if !ok {
							continue
						}
						sel, ok := call.Fun.(*ast.SelectorExpr)
						if !ok || sel.Sel.Name != "NewDecoder" {
							continue
						}
						pkgIdent, ok := sel.X.(*ast.Ident)
						if !ok || (pkgIdent.Name != "yaml" && pkgIdent.Name != "json") {
							continue
						}
						line := fset.Position(call.Pos()).Line
						if df.IsNew || lineInHunks(line, df.Hunks, 3) {
							varName := ""
							if i < len(node.Names) && node.Names[i].Name != "_" {
								varName = node.Names[i].Name
							}
							assignedCallPos[call.Pos()] = true
							sites = append(sites, decoderSite{ident: varName, line: line, pkg: pkgIdent.Name, kind: "NewDecoder"})
						}
					}
				case *ast.CallExpr:
					sel, ok := node.Fun.(*ast.SelectorExpr)
					if !ok {
						return true
					}
					switch sel.Sel.Name {
					case "KnownFields":
						if len(node.Args) == 1 {
							if id, ok := node.Args[0].(*ast.Ident); ok && id.Name == "true" {
								if recv, ok := sel.X.(*ast.Ident); ok {
									strictVars[recv.Name] = true
								}
							}
						}
					case "DisallowUnknownFields":
						if recv, ok := sel.X.(*ast.Ident); ok {
							strictVars[recv.Name] = true
						}
					case "NewDecoder":
						if assignedCallPos[node.Pos()] {
							return true
						}
						if pkgIdent, ok := sel.X.(*ast.Ident); ok && (pkgIdent.Name == "yaml" || pkgIdent.Name == "json") {
							line := fset.Position(node.Pos()).Line
							if df.IsNew || lineInHunks(line, df.Hunks, 3) {
								sites = append(sites, decoderSite{ident: "", line: line, pkg: pkgIdent.Name, kind: "NewDecoder"})
							}
						}
					case "Unmarshal":
						if pkgIdent, ok := sel.X.(*ast.Ident); ok && pkgIdent.Name == "yaml" {
							line := fset.Position(node.Pos()).Line
							if df.IsNew || lineInHunks(line, df.Hunks, 3) {
								sites = append(sites, decoderSite{ident: "", line: line, pkg: "yaml", kind: "Unmarshal"})
							}
						}
					}
				}
				return true
			})

			for _, s := range sites {
				if s.kind == "NewDecoder" && s.ident != "" && strictVars[s.ident] {
					continue
				}
				remedy := "dec.KnownFields(true)"
				if s.pkg == "json" {
					remedy = "dec.DisallowUnknownFields()"
				}
				summary := fmt.Sprintf("%s.NewDecoder in %s omits %s, silently dropping unknown configuration fields.", s.pkg, fn.Name.Name, remedy)
				if s.kind == "Unmarshal" {
					summary = fmt.Sprintf("yaml.Unmarshal in %s silently drops unknown configuration fields; use yaml.NewDecoder with %s.", fn.Name.Name, remedy)
				}
				findings = append(findings, Finding{
					RuleID:   qa.RuleStrictConfigDecoder,
					Stage:    "S3",
					Severity: "blocking",
					FilePath: p,
					Line:     s.line,
					Summary:  summary,
					Evidence: fmt.Sprintf("Call %s before Decode(...) or document an explicit wire-compatibility exemption with `// qa:allow-unknown-fields <reason>`.", remedy),
				})
				break
			}
		}
	}
	return findings, nil
}

func isConfigDecoderTarget(relPath string, f *ast.File, extraPaths []string) bool {
	lower := strings.ToLower(relPath)
	for _, kw := range defaultStrictDecoderKeywords {
		if strings.Contains(lower, strings.ToLower(kw)) {
			return true
		}
	}
	for _, ep := range extraPaths {
		ep = strings.ToLower(strings.TrimSpace(ep))
		if ep != "" && strings.Contains(lower, ep) {
			return true
		}
	}
	for _, imp := range f.Imports {
		val := strings.Trim(imp.Path.Value, `"`)
		if strings.Contains(val, "yaml") {
			return true
		}
	}
	return false
}

func fnHasAllowComment(groups []*ast.CommentGroup, fset *token.FileSet, fnStart, fnEnd int) bool {
	for _, cg := range groups {
		cLine := fset.Position(cg.Pos()).Line
		if cLine >= fnStart-3 && cLine <= fnEnd {
			if strings.Contains(cg.Text(), "qa:allow-unknown-fields") {
				return true
			}
		}
	}
	return false
}

func lineInHunks(line int, hunks []qa.LineRange, margin int) bool {
	for _, h := range hunks {
		if line >= h.Start-margin && line <= h.End+margin {
			return true
		}
	}
	return false
}
