export type LinearIssueReference = {
  identifier: string;
  url: string;
};

export function formatLinearIssueReference(issue: LinearIssueReference): string {
  return `${issue.identifier} (${issue.url})`;
}
