// Copyright 2026 The Grain Authors
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

import {
  RETIRED_CAPABILITY_HINT,
  capabilityRows,
  capabilityUnavailableHint,
  isCapabilityRef,
  normalizeRepoCiCapabilitiesState,
  parseCapabilityListInput,
  splitCiCapabilities,
} from "./repo-capabilities.helpers";

describe("repo-capabilities.helpers", () => {
  it("normalizes null slices and partitions legacy vs method refs", () => {
    const state = normalizeRepoCiCapabilitiesState({
      ciCapabilities: null,
      availableCICapabilities: [
        "package-publish",
        "https://grain.dev/capabilities/release#publish-tag",
      ],
    });
    expect(state).toEqual({
      ciCapabilities: [],
      availableCICapabilities: [
        "package-publish",
        "https://grain.dev/capabilities/release#publish-tag",
      ],
    });

    const split = splitCiCapabilities(
      [
        "package-publish",
        "retired-cap",
        "https://grain.dev/capabilities/release#publish-tag",
        "https://grain.dev/capabilities/custom#deploy",
      ],
      state.availableCICapabilities,
    );
    expect(isCapabilityRef("package-publish")).toBe(false);
    expect(
      isCapabilityRef("https://grain.dev/capabilities/custom#deploy"),
    ).toBe(true);
    expect(split.legacySelected).toEqual([
      "package-publish",
      "retired-cap",
      "https://grain.dev/capabilities/release#publish-tag",
    ]);
    expect(split.grantRefs).toEqual([
      "https://grain.dev/capabilities/custom#deploy",
    ]);
  });

  it("formats unavailable and retired capability hints", () => {
    expect(
      capabilityUnavailableHint({
        id: "registry-push",
        ready: false,
        needs: ["REGISTRY_URL", "REGISTRY_TOKEN"],
      }),
    ).toContain("Not ready -- needs REGISTRY_URL, REGISTRY_TOKEN");
    expect(capabilityUnavailableHint({ id: "x", ready: false })).toContain(
      "Not ready on this deployment",
    );

    const rows = capabilityRows(
      [
        { id: "a", ready: true },
        { id: "b", ready: false, needs: ["TOKEN"] },
        { id: "c", ready: false },
      ],
      ["b", "gone"],
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "gone"]);
    expect(rows[2].retired).toBe(true);
    expect(rows[2].description).toBe(RETIRED_CAPABILITY_HINT);
  });

  it("parses capability lists preserving JSON commas while rejecting invalid tokens", () => {
    const ok = parseCapabilityListInput(
      'api:tasks-read@acme/widgets, slack#post={"space":"ops,dev","tags":["a","b"]}',
    );
    expect(ok).toEqual({
      capabilities: [
        "api:tasks-read@acme/widgets",
        'slack#post={"space":"ops,dev","tags":["a","b"]}',
      ],
      error: null,
    });

    expect(parseCapabilityListInput("").capabilities).toEqual([]);
    expect(parseCapabilityListInput("a,,b").error).toContain("empty entry");
    expect(parseCapabilityListInput("a, ").error).toContain("empty entry");
    expect(parseCapabilityListInput('slack#post={"a":1').error).toContain(
      "unclosed JSON",
    );
    expect(parseCapabilityListInput("slack#post=[1,2]").error).toContain(
      "must be a JSON object",
    );
    expect(parseCapabilityListInput("foo bar").error).toContain(
      "cannot contain spaces",
    );
    expect(parseCapabilityListInput("grain#ci").error).toContain(
      "Repository CI mode",
    );
    expect(
      parseCapabilityListInput('repo#write={"repo":"acme/x"}').error,
    ).toContain("CI-only capability");
    expect(parseCapabilityListInput("api:tasks-read@").error).toContain(
      "api:<scope>",
    );
  });
});
