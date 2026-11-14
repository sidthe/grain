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

func TestValidateScriptName(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		// Valid names across boundaries and allowed characters.
		{name: "min length 3", input: "abc", wantErr: false},
		{name: "max length 32", input: strings.Repeat("a", 32), wantErr: false},
		{name: "length 31", input: strings.Repeat("Z", 31), wantErr: false},
		{name: "uppercase and lowercase", input: "DeployScript", wantErr: false},
		{name: "digits only", input: "0123456789", wantErr: false},
		{name: "hyphens and underscores", input: "my-script_01", wantErr: false},
		{name: "all hyphens min", input: "---", wantErr: false},
		{name: "all underscores min", input: "___", wantErr: false},
		{name: "leading hyphen and trailing underscore", input: "-a_", wantErr: false},
		{name: "all allowed classes", input: "AbCdEf0123456789-_XyZ", wantErr: false},

		// Rule 1: empty.
		{name: "empty", input: "", wantErr: true},

		// Rule 2: whitespace (ASCII and Unicode).
		{name: "single space", input: " ", wantErr: true},
		{name: "three spaces", input: "   ", wantErr: true},
		{name: "embedded space", input: "foo bar", wantErr: true},
		{name: "leading space", input: " foo", wantErr: true},
		{name: "trailing space", input: "foo ", wantErr: true},
		{name: "tab", input: "foo\tbar", wantErr: true},
		{name: "newline", input: "foo\nbar", wantErr: true},
		{name: "carriage return", input: "foo\rbar", wantErr: true},
		{name: "vertical tab", input: "foo\vbar", wantErr: true},
		{name: "form feed", input: "foo\fbar", wantErr: true},
		{name: "unicode nbsp", input: "foo\u00a0bar", wantErr: true},
		{name: "unicode em space", input: "foo\u2003bar", wantErr: true},
		{name: "unicode nel", input: "foo\u0085bar", wantErr: true},

		// Rule 3: slash or backslash.
		{name: "forward slash", input: "foo/bar", wantErr: true},
		{name: "leading slash", input: "/foobar", wantErr: true},
		{name: "trailing slash", input: "foobar/", wantErr: true},
		{name: "backslash", input: `foo\bar`, wantErr: true},
		{name: "leading backslash", input: `\foobar`, wantErr: true},
		{name: "trailing backslash", input: `foobar\`, wantErr: true},

		// Rule 4: length bounds [3, 32].
		{name: "length 1", input: "a", wantErr: true},
		{name: "length 2", input: "ab", wantErr: true},
		{name: "length 33", input: strings.Repeat("a", 33), wantErr: true},
		{name: "length 64", input: strings.Repeat("a", 64), wantErr: true},
		{name: "huge input", input: strings.Repeat("a", 1<<20), wantErr: true},

		// Rule 5: non-allowed characters and non-ASCII.
		{name: "dot", input: "foo.bar", wantErr: true},
		{name: "colon", input: "foo:bar", wantErr: true},
		{name: "plus", input: "foo+bar", wantErr: true},
		{name: "at", input: "foo@bar", wantErr: true},
		{name: "nul byte", input: "foo\x00bar", wantErr: true},
		{name: "non-ascii letter", input: "aéb", wantErr: true},
		{name: "non-ascii 32 runes", input: strings.Repeat("é", 32), wantErr: true},
		{name: "unicode fullwidth digit", input: "ab１", wantErr: true},
		{name: "unicode hyphen", input: "a\u2010b", wantErr: true},
		{name: "invalid utf8", input: "a\xffb", wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateScriptName(tc.input)
			if (err != nil) != tc.wantErr {
				t.Errorf("ValidateScriptName(%q) error = %v, wantErr %v", tc.input, err, tc.wantErr)
			}
		})
	}
}

func TestValidateScriptNameAllBytes(t *testing.T) {
	for b := 0; b <= 255; b++ {
		c := byte(b)
		wantValid := (c >= 'a' && c <= 'z') ||
			(c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') ||
			c == '-' ||
			c == '_'
		in := string([]byte{'a', c, 'b'})
		err := ValidateScriptName(in)
		if wantValid && err != nil {
			t.Errorf("ValidateScriptName(%q) [byte 0x%02x] unexpected error: %v", in, c, err)
		}
		if !wantValid && err == nil {
			t.Errorf("ValidateScriptName(%q) [byte 0x%02x] succeeded, want error", in, c)
		}
	}
}
