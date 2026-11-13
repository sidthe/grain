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
	"bytes"
	"context"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"path"
	"regexp"
	"sort"
	"strings"

	"github.com/ai-on-gke/grain/pkg/qa"
)

type modifiedExport struct {
	Symbol        string
	LookupSymbol  string
	File          string
	Line          int
	ChangeSummary string
	Breaking      bool
}

var tsExportedDeclRe = regexp.MustCompile(`(?m)^\s*export\s+(?:function|interface|class|type)\s+([A-Za-z_][A-Za-z0-9_]*)\b([^\n{;]*)`)

// CheckSiblingExportHazard detects modified exported Go/TypeScript declarations referenced by
// sibling packages that have zero modified files in base...HEAD.
//
// Always returns hazardSites and maxSiblingPkgCount (used by S1 BlastTier classification and S4
// Inquisitor grounding). Emits blocking <hazard_card> findings only on attempt <= 1 when callerNotes
// is empty, clearing cleanly once sibling callers are updated or explained via caller_notes.
func CheckSiblingExportHazard(
	ctx context.Context,
	ws WorkspaceReader,
	pd ParsedDiff,
	attempt int,
	callerNotes string,
) (findings []Finding, hazardSites map[string][]int, maxSiblingPkgs int, err error) {
	hazardSites = map[string][]int{}
	touchedDirs := map[string]bool{}
	for _, df := range pd.Files {
		if p := df.EffectivePath(); p != "" && !isTestPath(p) {
			touchedDirs[path.Dir(p)] = true
		}
	}

	var changedExports []modifiedExport
	for _, df := range pd.Files {
		if df.IsNew || df.IsDeleted {
			continue
		}
		p := df.EffectivePath()
		if isTestPath(p) {
			continue
		}
		switch {
		case strings.HasSuffix(p, ".go"):
			baseBytes, bErr := ws.ReadFileAtBase(ctx, nonEmptyPath(df.OldPath, p))
			headBytes, hErr := ws.ReadFileAtHead(ctx, p)
			if bErr == nil && hErr == nil {
				changedExports = append(changedExports, diffGoExports(p, baseBytes, headBytes)...)
			}
		case strings.HasSuffix(p, ".ts"):
			baseBytes, bErr := ws.ReadFileAtBase(ctx, nonEmptyPath(df.OldPath, p))
			headBytes, hErr := ws.ReadFileAtHead(ctx, p)
			if bErr == nil && hErr == nil {
				changedExports = append(changedExports, diffTSExports(p, string(baseBytes), string(headBytes))...)
			}
		}
	}

	hasWaiver := strings.TrimSpace(callerNotes) != ""
	seenSymbol := map[string]bool{}

	for _, exp := range changedExports {
		key := path.Dir(exp.File) + ":" + exp.Symbol
		if seenSymbol[key] {
			continue
		}
		seenSymbol[key] = true

		grepSym := exp.LookupSymbol
		if grepSym == "" {
			grepSym = exp.Symbol
		}
		sites, gErr := ws.GrepSymbolSites(ctx, grepSym)
		if gErr != nil {
			continue
		}

		ownDir := path.Dir(exp.File)
		siblingAllDirs := map[string]bool{}
		untouchedDirs := map[string][]CallSite{}

		for _, site := range sites {
			if isTestPath(site.File) {
				continue
			}
			siteDir := path.Dir(site.File)
			if siteDir == ownDir {
				continue
			}
			siblingAllDirs[siteDir] = true
			if !touchedDirs[siteDir] {
				untouchedDirs[siteDir] = append(untouchedDirs[siteDir], site)
				hazardSites[site.File] = append(hazardSites[site.File], site.Line)
			}
		}

		if len(siblingAllDirs) > maxSiblingPkgs {
			maxSiblingPkgs = len(siblingAllDirs)
		}
		if len(untouchedDirs) == 0 {
			continue
		}
		// Cap noisy ubiquitous symbols (>25 sibling packages) to signature-breaking changes only.
		if len(untouchedDirs) > 25 && !exp.Breaking {
			continue
		}
		if attempt > 1 || hasWaiver {
			continue
		}

		var dirList []string
		for d := range untouchedDirs {
			dirList = append(dirList, d)
		}
		sort.Strings(dirList)

		var examples []string
		for _, d := range dirList {
			cs := untouchedDirs[d][0]
			examples = append(examples, fmt.Sprintf("%s:%d (%s)", cs.File, cs.Line, truncateLine(cs.Snippet, 90)))
			if len(examples) >= 5 {
				break
			}
		}

		findings = append(findings, Finding{
			RuleID:   qa.RuleSiblingExportHazard,
			Stage:    "S3",
			Severity: "blocking",
			FilePath: exp.File,
			Line:     exp.Line,
			Summary: fmt.Sprintf("Modified exported symbol %s (%s) has %d untouched sibling caller package(s).",
				exp.Symbol, exp.ChangeSummary, len(untouchedDirs)),
			Evidence: fmt.Sprintf("<hazard_card symbol=%q untouched_packages=%d>\n%s\nUpdate affected sibling callers or pass `caller_notes` to `open_pull_request` explaining why those callers remain compatible.\n</hazard_card>",
				exp.Symbol, len(untouchedDirs), strings.Join(examples, "\n")),
		})
	}

	return findings, hazardSites, maxSiblingPkgs, nil
}

type goSymbolSnap struct {
	LookupSymbol string
	Sig          string
	Fields       map[string]string
	Line         int
	Kind         string // "func", "struct", "interface"
}

func diffGoExports(filePath string, baseBytes, headBytes []byte) []modifiedExport {
	baseMap := extractGoExports(filePath, baseBytes)
	headMap := extractGoExports(filePath, headBytes)
	var out []modifiedExport

	for name, bSnap := range baseMap {
		lookup := bSnap.LookupSymbol
		if lookup == "" {
			lookup = name
		}
		hSnap, exists := headMap[name]
		if !exists {
			out = append(out, modifiedExport{
				Symbol:        name,
				LookupSymbol:  lookup,
				File:          filePath,
				Line:          1,
				ChangeSummary: fmt.Sprintf("removed exported %s", bSnap.Kind),
				Breaking:      true,
			})
			continue
		}
		switch bSnap.Kind {
		case "func":
			if bSnap.Sig != hSnap.Sig {
				out = append(out, modifiedExport{
					Symbol:        name,
					LookupSymbol:  lookup,
					File:          filePath,
					Line:          hSnap.Line,
					ChangeSummary: "changed function/method signature",
					Breaking:      true,
				})
			}
		case "interface":
			if bSnap.Sig != hSnap.Sig {
				out = append(out, modifiedExport{
					Symbol:        name,
					LookupSymbol:  lookup,
					File:          filePath,
					Line:          hSnap.Line,
					ChangeSummary: "changed exported interface method set",
					Breaking:      true,
				})
			}
		case "struct":
			breaking := false
			changed := false
			var reason string
			for fName, bType := range bSnap.Fields {
				hType, ok := hSnap.Fields[fName]
				if !ok {
					breaking = true
					changed = true
					reason = fmt.Sprintf("removed/renamed struct field %s", fName)
					break
				}
				if bType != hType {
					breaking = true
					changed = true
					reason = fmt.Sprintf("changed type of struct field %s", fName)
					break
				}
			}
			if !changed {
				for fName := range hSnap.Fields {
					if _, ok := bSnap.Fields[fName]; !ok {
						changed = true
						reason = fmt.Sprintf("added exported struct field %s", fName)
						break
					}
				}
			}
			if changed {
				out = append(out, modifiedExport{
					Symbol:        name,
					LookupSymbol:  lookup,
					File:          filePath,
					Line:          hSnap.Line,
					ChangeSummary: reason,
					Breaking:      breaking,
				})
			}
		}
	}
	return out
}

func extractGoExports(filePath string, src []byte) map[string]goSymbolSnap {
	out := map[string]goSymbolSnap{}
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, filePath, src, 0)
	if err != nil {
		return out
	}

	for _, decl := range f.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			if !ast.IsExported(d.Name.Name) {
				continue
			}
			symName := d.Name.Name
			mapKey := symName
			if d.Recv != nil && len(d.Recv.List) > 0 {
				recvType := exprString(fset, d.Recv.List[0].Type)
				recvBase := strings.TrimPrefix(recvType, "*")
				if idx := strings.IndexByte(recvBase, '['); idx > 0 {
					recvBase = recvBase[:idx]
				}
				if !ast.IsExported(recvBase) {
					continue
				}
				if isUbiquitousMethodName(symName) {
					continue
				}
				mapKey = recvBase + "." + symName
			}
			out[mapKey] = goSymbolSnap{
				LookupSymbol: symName,
				Sig:          funcTypeSignature(fset, d.Type),
				Line:         fset.Position(d.Pos()).Line,
				Kind:         "func",
			}
		case *ast.GenDecl:
			if d.Tok != token.TYPE {
				continue
			}
			for _, spec := range d.Specs {
				ts, ok := spec.(*ast.TypeSpec)
				if !ok || !ast.IsExported(ts.Name.Name) {
					continue
				}
				switch typ := ts.Type.(type) {
				case *ast.StructType:
					fields := map[string]string{}
					if typ.Fields != nil {
						for _, fl := range typ.Fields.List {
							tStr := exprString(fset, fl.Type)
							if len(fl.Names) == 0 {
								if ast.IsExported(strings.TrimPrefix(tStr, "*")) {
									fields[tStr] = tStr
								}
								continue
							}
							for _, n := range fl.Names {
								if ast.IsExported(n.Name) {
									fields[n.Name] = tStr
								}
							}
						}
					}
					out[ts.Name.Name] = goSymbolSnap{
						Fields: fields,
						Line:   fset.Position(ts.Pos()).Line,
						Kind:   "struct",
					}
				case *ast.InterfaceType:
					out[ts.Name.Name] = goSymbolSnap{
						Sig:  exprString(fset, typ),
						Line: fset.Position(ts.Pos()).Line,
						Kind: "interface",
					}
				}
			}
		}
	}
	return out
}

func funcTypeSignature(fset *token.FileSet, ft *ast.FuncType) string {
	if ft == nil {
		return ""
	}
	var params, results []string
	if ft.Params != nil {
		for _, p := range ft.Params.List {
			tStr := exprString(fset, p.Type)
			count := len(p.Names)
			if count == 0 {
				count = 1
			}
			for i := 0; i < count; i++ {
				params = append(params, tStr)
			}
		}
	}
	if ft.Results != nil {
		for _, r := range ft.Results.List {
			tStr := exprString(fset, r.Type)
			count := len(r.Names)
			if count == 0 {
				count = 1
			}
			for i := 0; i < count; i++ {
				results = append(results, tStr)
			}
		}
	}
	return "(" + strings.Join(params, ",") + ")->(" + strings.Join(results, ",") + ")"
}

func exprString(fset *token.FileSet, expr ast.Expr) string {
	var buf bytes.Buffer
	if err := format.Node(&buf, fset, expr); err != nil {
		return ""
	}
	return buf.String()
}

func isUbiquitousMethodName(name string) bool {
	switch name {
	case "String", "Error", "Close", "Read", "Write", "ServeHTTP", "MarshalJSON", "UnmarshalJSON", "Clone", "Equal", "IsZero":
		return true
	default:
		return false
	}
}

func diffTSExports(filePath, baseText, headText string) []modifiedExport {
	baseDecls := extractTSExports(baseText)
	headDecls := extractTSExports(headText)
	var out []modifiedExport
	for name, bSig := range baseDecls {
		hSig, ok := headDecls[name]
		if !ok {
			out = append(out, modifiedExport{
				Symbol:        name,
				File:          filePath,
				Line:          1,
				ChangeSummary: "removed TypeScript export",
				Breaking:      true,
			})
		} else if bSig.sig != hSig.sig {
			out = append(out, modifiedExport{
				Symbol:        name,
				File:          filePath,
				Line:          hSig.line,
				ChangeSummary: "changed TypeScript export signature",
				Breaking:      true,
			})
		}
	}
	return out
}

type tsSig struct {
	sig  string
	line int
}

func extractTSExports(src string) map[string]tsSig {
	out := map[string]tsSig{}
	locs := tsExportedDeclRe.FindAllStringSubmatchIndex(src, -1)
	for _, loc := range locs {
		name := src[loc[2]:loc[3]]
		sig := strings.TrimSpace(src[loc[4]:loc[5]])
		line := strings.Count(src[:loc[0]], "\n") + 1
		out[name] = tsSig{sig: sig, line: line}
	}
	return out
}

func nonEmptyPath(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func truncateLine(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
