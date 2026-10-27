/** The per-repo changelog-gate config: the only file that differs between repos. */
export const GATE_CONFIG = {
  releaseBranchPattern: /^release\//,
  // publish.yml opens the release-state PR with GH_PAT, so its author is this account.
  releaseActors: ["sisyphus-dev-ai"],
  // Unused here: check-pr-changelog.ts passes the shipped-surface classifier (changelog-shipping-policy.mjs) as
  // isUserFacing, which replaces the root rule for every verdict (#10841).
  userFacingRoots: [],
  // Exactly what publish.yml's release commit stages besides CHANGELOG.md and the fragments.
  releaseArtifacts: [
    /^package\.json$/,
    /^bun\.lock$/,
    /^packages\/[^/]+\/package\.json$/,
    // stamp-release-changelog.ts writes the fragments' log blocks into their logs in the release commit.
    /^packages\/[^/]+\/changes\.md$/,
  ],
} as const;
