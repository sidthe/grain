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

import { describe, expect, it } from "vitest";
import { validateFleetModel } from "./fleet.models";

describe("validateFleetModel", () => {
  it("accepts valid model names and node counts within (0, 1000]", () => {
    expect(validateFleetModel("abc", 1)).toBe(true);
    expect(validateFleetModel("gemini-2.5-pro", 4)).toBe(true);
    expect(validateFleetModel("model-v1", 1000)).toBe(true);
    expect(validateFleetModel("org/llama-3.1_70b:latest", 500)).toBe(true);
    expect(validateFleetModel("abc", 0.5)).toBe(true);
    expect(validateFleetModel("abc", 999.9)).toBe(true);
    expect(validateFleetModel("🤖a", 1)).toBe(true);
    expect(validateFleetModel("m".repeat(1000), 50)).toBe(true);
  });

  it("rejects node counts <= 0, > 1000, or non-finite", () => {
    expect(validateFleetModel("valid-model", 0)).toBe(false);
    expect(validateFleetModel("valid-model", -0)).toBe(false);
    expect(validateFleetModel("valid-model", -1)).toBe(false);
    expect(validateFleetModel("valid-model", -100)).toBe(false);
    expect(validateFleetModel("valid-model", 1000.0001)).toBe(false);
    expect(validateFleetModel("valid-model", 1001)).toBe(false);
    expect(validateFleetModel("valid-model", Number.MAX_SAFE_INTEGER)).toBe(
      false,
    );
    expect(validateFleetModel("valid-model", Number.MIN_SAFE_INTEGER)).toBe(
      false,
    );
    expect(validateFleetModel("valid-model", Number.NaN)).toBe(false);
    expect(validateFleetModel("valid-model", Number.POSITIVE_INFINITY)).toBe(
      false,
    );
    expect(validateFleetModel("valid-model", Number.NEGATIVE_INFINITY)).toBe(
      false,
    );
  });

  it("rejects model names shorter than 3 characters", () => {
    expect(validateFleetModel("", 10)).toBe(false);
    expect(validateFleetModel("a", 10)).toBe(false);
    expect(validateFleetModel("ab", 10)).toBe(false);
    expect(validateFleetModel("🤖", 10)).toBe(false);
  });

  it("rejects model names containing spaces", () => {
    expect(validateFleetModel("a b", 10)).toBe(false);
    expect(validateFleetModel(" abc", 10)).toBe(false);
    expect(validateFleetModel("abc ", 10)).toBe(false);
    expect(validateFleetModel("   ", 10)).toBe(false);
    expect(validateFleetModel("gemini 2.5 pro", 10)).toBe(false);
    expect(validateFleetModel("a".repeat(50) + " " + "b".repeat(50), 10)).toBe(
      false,
    );
  });

  it("rejects combined invalid inputs and non-string/non-number runtime values", () => {
    expect(validateFleetModel("", 0)).toBe(false);
    expect(validateFleetModel("ab cd", 1001)).toBe(false);
    expect(validateFleetModel(null as unknown as string, 10)).toBe(false);
    expect(validateFleetModel(undefined as unknown as string, 10)).toBe(false);
    expect(validateFleetModel("valid-model", null as unknown as number)).toBe(
      false,
    );
    expect(
      validateFleetModel("valid-model", undefined as unknown as number),
    ).toBe(false);
    expect(validateFleetModel("valid-model", "10" as unknown as number)).toBe(
      false,
    );
  });
});
