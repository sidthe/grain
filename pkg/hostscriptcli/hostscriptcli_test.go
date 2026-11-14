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

package hostscriptcli

import (
	"bytes"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// fakeEndpoint answers exec calls as the host-script server would: it
// echoes the decoded argv on stdout, one frame each, and exits 3.
func fakeEndpoint(t *testing.T, token string) (port int, seen *http.Header) {
	t.Helper()
	var hdr http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hdr = r.Header.Clone()
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			io.WriteString(w, "e refused\\012\nx 125\n")
			return
		}
		body, _ := io.ReadAll(r.Body)
		argvPart := string(body)
		var stdinPart []byte
		hasStdin := false
		if idx := bytes.Index(body, []byte("\n"+StdinSeparator+"\n")); idx >= 0 {
			argvPart = string(body[:idx+1])
			stdinPart = body[idx+1+len(StdinSeparator)+1:]
			hasStdin = true
		} else if bytes.HasPrefix(body, []byte(StdinSeparator+"\n")) {
			argvPart = ""
			stdinPart = body[len(StdinSeparator)+1:]
			hasStdin = true
		}
		for _, line := range strings.Split(strings.TrimSuffix(argvPart, "\n"), "\n") {
			if line == "" && len(argvPart) == 0 {
				break
			}
			b, _ := hex.DecodeString(line)
			io.WriteString(w, "o ["+strings.ReplaceAll(string(b), "\n", "\\012")+"]\\012\n")
		}
		if hasStdin {
			io.WriteString(w, "o stdin="+hex.EncodeToString(stdinPart)+"\\012\n")
		}
		io.WriteString(w, "e done\\012\nx 3\n")
	}))
	t.Cleanup(srv.Close)
	_, p, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port, _ = strconv.Atoi(p)
	return port, &hdr
}

func place(t *testing.T, dir string, d Descriptor) {
	t.Helper()
	b, err := Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, d.Name+".json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func run(dir string, args ...string) (int, string, string) {
	var out, errb bytes.Buffer
	code := Run(dir, args, &out, &errb)
	return code, out.String(), errb.String()
}

func TestRun(t *testing.T) {
	port, hdr := fakeEndpoint(t, "tok")
	dir := t.TempDir()
	place(t, dir, Descriptor{Name: "deploy", Description: "deploys <things> & more", Usage: "deploy ENV\nENV is \"prod\" or staging.", Port: port, AttemptID: "e1-1-1-0", Token: "tok"})
	place(t, dir, Descriptor{Name: "bad-token", Description: "refused", Port: port, AttemptID: "e1-1-1-1", Token: "nope"})

	code, out, errs := run(dir, "deploy", "two words", "a\nb", "")
	if code != 3 || out != "[two words]\n[a\nb]\n[]\n" || errs != "done\n" {
		t.Errorf("call = %d %q %q", code, out, errs)
	}
	if got := hdr.Get("Content-Type"); got != ArgvType {
		t.Errorf("Content-Type %q, want %q", got, ArgvType)
	}
	if code, _, errs := run(dir, "bad-token"); code != ExitProtocol || errs != "refused\n" {
		t.Errorf("a refused token = %d %q, want 125 and the server's reason", code, errs)
	}
	for _, args := range [][]string{{"deploy", "--grain-help"}, {"--help", "deploy"}} {
		code, out, _ := run(dir, args...)
		if code != 0 || !strings.Contains(out, "grain host-script deploy [arguments...]") ||
			!strings.Contains(out, "grain host-script --stdin deploy [arguments...]") ||
			!strings.Contains(out, "deploys <things> & more") || !strings.Contains(out, "ENV is \"prod\" or staging.") {
			t.Errorf("%v = %d %q", args, code, out)
		}
	}
	if code, out, _ := run(dir, "--list"); code != 0 || out != "bad-token\trefused\ndeploy\tdeploys <things> & more\n" {
		t.Errorf("--list = %d %q", code, out)
	}
	if code, _, errs := run(dir, "missing"); code != ExitProtocol || !strings.Contains(errs, `no host script "missing" is granted`) {
		t.Errorf("an ungranted script = %d %q", code, errs)
	}
	if code, _, _ := run(dir, "../deploy"); code != 2 {
		t.Errorf("a path as a name = %d, want 2", code)
	}
	if code, _, _ := run(dir); code != 2 {
		t.Errorf("no arguments = %d, want 2", code)
	}
}

// The descriptor is one field to a line with no HTML escaping, which
// FallbackScript's sed relies on.
func TestMarshalIsOneFieldToALine(t *testing.T) {
	b, err := Marshal(Descriptor{Name: "x", Description: "a <b>\nc", Port: 1, AttemptID: "e1", Token: "t"})
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"name\": \"x\",\n  \"description\": \"a <b>\\nc\",\n  \"port\": 1,\n  \"attempt_id\": \"e1\",\n  \"token\": \"t\"\n}\n"
	if string(b) != want {
		t.Errorf("Marshal = %q, want %q", b, want)
	}
}

func TestRunWithStdinAndApprovalHelp(t *testing.T) {
	port, _ := fakeEndpoint(t, "tok")
	dir := t.TempDir()
	place(t, dir, Descriptor{Name: "apply", Description: "applies manifest", Approve: true, Port: port, AttemptID: "e1-1-1-0", Token: "tok"})

	payload := []byte("line1\n---\n\x00\xfftail")
	var out, errb bytes.Buffer
	code := RunWithStdin(dir, []string{"--stdin", "apply", "--env", "prod"}, bytes.NewReader(payload), &out, &errb)
	wantOut := "[--env]\n[prod]\nstdin=" + hex.EncodeToString(payload) + "\n"
	if code != 3 || out.String() != wantOut || errb.String() != "done\n" {
		t.Errorf("--stdin apply = %d %q %q, want %q", code, out.String(), errb.String(), wantOut)
	}

	// Without --stdin before <name>, stdin is not sent and --stdin after <name> is a literal argument.
	out.Reset()
	errb.Reset()
	code = RunWithStdin(dir, []string{"apply", "--stdin"}, bytes.NewReader(payload), &out, &errb)
	if code != 3 || out.String() != "[--stdin]\n" {
		t.Errorf("apply --stdin = %d %q, want literal [--stdin] with no stdin frame", code, out.String())
	}

	_, helpOut, _ := run(dir, "apply", "--grain-help")
	if !strings.Contains(helpOut, "Each call waits for a person's approval before it runs.") {
		t.Errorf("approve: true help = %q, want approval note", helpOut)
	}
}

func TestValidateScriptNameValid(t *testing.T) {
	t.Parallel()

	valid := []string{
		"abc",
		"ABC",
		"123",
		"---",
		"___",
		"-a_",
		"_A-",
		"deploy",
		"bad-token",
		"My_Script-01",
		"HOST_SCRIPT_99",
		"0123456789",
		strings.Repeat("a", 3),
		strings.Repeat("Z", 32),
		"abcdefghijklmnopqrstuvwxyz012345",
		"A1_-bcdefghijklmnopqrstuvwxyz012",
	}
	for _, name := range valid {
		if err := ValidateScriptName(name); err != nil {
			t.Errorf("ValidateScriptName(%q) unexpected error: %v", name, err)
		}
	}
}

func TestValidateScriptNameInvalid(t *testing.T) {
	t.Parallel()

	cases := []struct {
		desc string
		name string
	}{
		{desc: "empty", name: ""},
		{desc: "len_1_letter", name: "a"},
		{desc: "len_1_digit", name: "1"},
		{desc: "len_1_dash", name: "-"},
		{desc: "len_1_underscore", name: "_"},
		{desc: "len_2", name: "ab"},
		{desc: "len_2_symbols", name: "-_"},
		{desc: "len_33", name: strings.Repeat("a", 33)},
		{desc: "len_64", name: strings.Repeat("a", 64)},
		{desc: "len_128", name: strings.Repeat("a", 128)},
		{desc: "len_129", name: strings.Repeat("a", 129)},
		{desc: "space_only", name: "   "},
		{desc: "space_single", name: " "},
		{desc: "space_middle", name: "a b"},
		{desc: "space_leading", name: " abc"},
		{desc: "space_trailing", name: "abc "},
		{desc: "tab", name: "a\tb"},
		{desc: "newline", name: "a\nb"},
		{desc: "carriage_return", name: "a\rb"},
		{desc: "vertical_tab", name: "a\vb"},
		{desc: "form_feed", name: "a\fb"},
		{desc: "unicode_nbsp", name: "a\u00a0b"},
		{desc: "unicode_em_space", name: "a\u2003b"},
		{desc: "unicode_ideographic_space", name: "a\u3000b"},
		{desc: "slash_middle", name: "foo/bar"},
		{desc: "slash_leading", name: "/abc"},
		{desc: "slash_trailing", name: "abc/"},
		{desc: "slash_only", name: "///"},
		{desc: "backslash_middle", name: `foo\bar`},
		{desc: "backslash_leading", name: `\abc`},
		{desc: "backslash_trailing", name: `abc\`},
		{desc: "backslash_only", name: `\\\`},
		{desc: "dot_traversal_slash", name: "../foo"},
		{desc: "dot_traversal_backslash", name: `..\foo`},
		{desc: "dot", name: "foo.sh"},
		{desc: "colon", name: "foo:bar"},
		{desc: "at", name: "foo@bar"},
		{desc: "plus", name: "foo+bar"},
		{desc: "dollar", name: "foo$bar"},
		{desc: "asterisk", name: "foo*bar"},
		{desc: "nul_byte", name: "foo\x00bar"},
		{desc: "control_char", name: "foo\x1fbar"},
		{desc: "del_char", name: "foo\x7fbar"},
		{desc: "non_ascii_latin", name: "café"},
		{desc: "non_ascii_3_runes", name: "ééé"},
		{desc: "non_ascii_2_runes", name: "éé"},
		{desc: "non_ascii_greek", name: "αβγ"},
		{desc: "non_ascii_digit", name: "foo０bar"},
		{desc: "non_ascii_arabic_digit", name: "foo٢bar"},
		{desc: "emoji", name: "foo😀bar"},
		{desc: "invalid_utf8_0x80", name: "foo\x80bar"},
		{desc: "invalid_utf8_0xff", name: "foo\xffbar"},
	}
	for _, tc := range cases {
		t.Run(tc.desc, func(t *testing.T) {
			if err := ValidateScriptName(tc.name); err == nil {
				t.Errorf("ValidateScriptName(%q) = nil, want error", tc.name)
			}
		})
	}
}

func TestValidateScriptNameHugeInputs(t *testing.T) {
	t.Parallel()

	hugeInputs := []struct {
		desc string
		name string
	}{
		{desc: "huge_ascii", name: strings.Repeat("a", 1<<20)},
		{desc: "huge_whitespace", name: strings.Repeat(" ", 1<<20)},
		{desc: "huge_slashes", name: strings.Repeat("/", 1<<20)},
		{desc: "huge_multibyte", name: strings.Repeat("é", 1<<18)},
	}
	for _, tc := range hugeInputs {
		t.Run(tc.desc, func(t *testing.T) {
			err := ValidateScriptName(tc.name)
			if err == nil {
				t.Fatalf("ValidateScriptName(huge len=%d) = nil, want error", len(tc.name))
			}
			if len(err.Error()) >= 256 {
				t.Fatalf("ValidateScriptName(huge) error message unexpectedly large (%d bytes)", len(err.Error()))
			}
		})
	}
}
