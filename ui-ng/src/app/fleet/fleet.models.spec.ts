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

import { validateFleetModel } from "./fleet.models";

describe("validateFleetModel", () => {
  it("accepts valid model names and node counts within bounds", () => {
    expect(validateFleetModel("gemini-2.5", 10)).toBe(true);
    expect(validateFleetModel("abc", 1)).toBe(true);
    expect(validateFleetModel("abc", 1000)).toBe(true);
    expect(validateFleetModel("model_v1", 0.5)).toBe(true);
  });

  it("rejects nodes <= 0, > 1000, or non-finite values", () => {
    expect(validateFleetModel("gemini-2.5", 0)).toBe(false);
    expect(validateFleetModel("gemini-2.5", -1)).toBe(false);
    expect(validateFleetModel("gemini-2.5", 1000.1)).toBe(false);
    expect(validateFleetModel("gemini-2.5", 1001)).toBe(false);
    expect(validateFleetModel("gemini-2.5", Number.NaN)).toBe(false);
    expect(validateFleetModel("gemini-2.5", Number.POSITIVE_INFINITY)).toBe(
      false,
    );
    expect(validateFleetModel("gemini-2.5", Number.NEGATIVE_INFINITY)).toBe(
      false,
    );
  });

  it("rejects model names shorter than 3 characters", () => {
    expect(validateFleetModel("", 10)).toBe(false);
    expect(validateFleetModel("a", 10)).toBe(false);
    expect(validateFleetModel("ab", 10)).toBe(false);
  });

  it("rejects model names containing spaces", () => {
    expect(validateFleetModel("a b", 10)).toBe(false);
    expect(validateFleetModel(" abc", 10)).toBe(false);
    expect(validateFleetModel("abc ", 10)).toBe(false);
    expect(validateFleetModel("   ", 10)).toBe(false);
    expect(validateFleetModel("gemini 2.5 pro", 10)).toBe(false);
  });

  it("rejects invalid runtime input types", () => {
    expect(validateFleetModel(null as unknown as string, 10)).toBe(false);
    expect(validateFleetModel("abc", undefined as unknown as number)).toBe(
      false,
    );
  });
});
