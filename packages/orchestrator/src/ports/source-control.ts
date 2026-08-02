/**
 * Driven port over the product repository's remote (D6 SHA-pinning; distinct
 * from the validator's SourceCloner, which materializes a working copy for
 * checks — this port only reads refs and advances the target branch).
 */

export interface SourceControl {
  /**
   * Resolve the engagement branch head ONCE at report time; the returned SHA
   * is the only thing validated or merged — the branch name is never
   * dereferenced again (an agent pushing after "done" produces a new report,
   * never a re-judgment). Null when the branch does not exist — the
   * hollow-completion signal (matrix model-floor addendum).
   */
  resolveRemoteSha(repoUrl: string, branch: string): Promise<string | null>;
  /**
   * Advance targetBranch to exactly sha, fast-forward only — a non-ff target
   * is an error, never a merge commit (merges are Guild-mediated, D6).
   */
  fastForward(repoUrl: string, targetBranch: string, sha: string): Promise<void>;
}
