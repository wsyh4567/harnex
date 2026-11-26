import { describe, expect, test } from "bun:test";
import type { HarnessTree } from "@harnex/interfaces";
import {
  DISABLED_ORGANS_PATH,
  listSubagentProfiles,
  loadDisabledOrgans,
  loadSkills,
  loadSubagentProfile,
} from "./slots.ts";

describe("organ disable filtering and sub-agent profile discovery", () => {
  test("loadDisabledOrgans gracefully handles missing, empty, invalid JSON, and invalid schema", () => {
    expect(DISABLED_ORGANS_PATH).toBe("meta/disabled_organs.json");
    expect(loadDisabledOrgans({})).toEqual(new Set());
    expect(loadDisabledOrgans({ [DISABLED_ORGANS_PATH]: "" })).toEqual(new Set());
    expect(loadDisabledOrgans({ [DISABLED_ORGANS_PATH]: "{not-json" })).toEqual(new Set());
    expect(loadDisabledOrgans({ [DISABLED_ORGANS_PATH]: JSON.stringify({ disabled: "not-an-array" }) })).toEqual(
      new Set(),
    );
    expect(loadDisabledOrgans({ [DISABLED_ORGANS_PATH]: JSON.stringify({ other: [] }) })).toEqual(new Set());
  });

  test("loadDisabledOrgans normalizes backslashes and leading ./ prefixes", () => {
    const tree: HarnessTree = {
      [DISABLED_ORGANS_PATH]: JSON.stringify({
        disabled: [
          "./skills/alpha/SKILL.md",
          ".\\sub_agents\\researcher.md",
          "././skills\\beta\\SKILL.md",
          "sub_agents/helper.md",
        ],
      }),
    };
    expect(loadDisabledOrgans(tree)).toEqual(
      new Set([
        "skills/alpha/SKILL.md",
        "sub_agents/researcher.md",
        "skills/beta/SKILL.md",
        "sub_agents/helper.md",
      ]),
    );
  });

  test("loadSkills filters disabled skills by default and includes them when includeDisabled is true", () => {
    const tree: HarnessTree = {
      "skills/alpha/SKILL.md": "---\nname: alpha\ndescription: Alpha skill\n---\nAlpha body",
      "skills/beta/SKILL.md": "---\nname: beta\ndescription: Beta skill\n---\nBeta body",
      [DISABLED_ORGANS_PATH]: JSON.stringify({ disabled: ["./skills\\alpha\\SKILL.md"] }),
    };

    expect(loadSkills(tree)).toEqual([
      {
        path: "skills/beta/SKILL.md",
        name: "beta",
        description: "Beta skill",
        body: "Beta body",
      },
    ]);

    expect(loadSkills(tree, { includeDisabled: true })).toEqual([
      {
        path: "skills/alpha/SKILL.md",
        name: "alpha",
        description: "Alpha skill",
        body: "Alpha body",
      },
      {
        path: "skills/beta/SKILL.md",
        name: "beta",
        description: "Beta skill",
        body: "Beta body",
      },
    ]);
  });

  test("loadSubagentProfile supports exact path and shorthand name while rejecting path traversal", () => {
    const tree: HarnessTree = {
      "sub_agents/researcher.md": "---\nname: researcher\ndescription: Codebase researcher\n---\nRead carefully.",
      "sub_agents/v1.helper-a.md": "Plain helper instructions",
      "secret.md": "Should never be reachable",
    };

    expect(loadSubagentProfile(tree, "sub_agents/researcher.md")).toEqual({
      profilePath: "sub_agents/researcher.md",
      name: "researcher",
      description: "Codebase researcher",
      instructions: "Read carefully.",
    });

    expect(loadSubagentProfile(tree, "researcher")).toEqual({
      profilePath: "sub_agents/researcher.md",
      name: "researcher",
      description: "Codebase researcher",
      instructions: "Read carefully.",
    });

    expect(loadSubagentProfile(tree, "v1.helper-a")).toEqual({
      profilePath: "sub_agents/v1.helper-a.md",
      name: "v1.helper-a.md",
      description: "",
      instructions: "Plain helper instructions",
    });

    const invalidRefs = [
      "../secret",
      "../secret.md",
      "sub_agents/../secret.md",
      "sub_agents/nested/researcher.md",
      "sub_agents\\researcher.md",
      "..",
      ".",
      "a/b",
      "a\\b",
      "foo..bar",
      "nonexistent",
      "",
    ];
    for (const ref of invalidRefs) {
      expect(() => loadSubagentProfile(tree, ref)).toThrow("Unknown sub-agent profile");
    }
  });

  test("listSubagentProfiles lists profiles sorted lexicographically and respects disabled organs", () => {
    const tree: HarnessTree = {
      "sub_agents/zeta.md": "---\nname: zeta\ndescription: Zeta agent\n---\nZeta",
      "sub_agents/alpha.md": "---\nname: alpha\ndescription: Alpha agent\n---\nAlpha",
      "sub_agents/researcher.md": "---\nname: researcher\ndescription: Researcher\n---\nResearch",
      "sub_agents/nested/ignored.md": "Ignored nested file",
      "sub_agents/notes.txt": "Ignored non-markdown file",
      [DISABLED_ORGANS_PATH]: JSON.stringify({ disabled: ["sub_agents/researcher.md"] }),
    };

    expect(listSubagentProfiles(tree).map((p) => p.profilePath)).toEqual([
      "sub_agents/alpha.md",
      "sub_agents/zeta.md",
    ]);

    expect(listSubagentProfiles(tree, { includeDisabled: true }).map((p) => p.profilePath)).toEqual([
      "sub_agents/alpha.md",
      "sub_agents/researcher.md",
      "sub_agents/zeta.md",
    ]);
  });
});
