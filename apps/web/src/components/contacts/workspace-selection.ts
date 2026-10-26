/**
 * Contacts page workspace selection, kept consistent with the active
 * organization: a selection is used only when it is one of the workspaces
 * fetched for that organization, so a workspace from a previous organization
 * can never be queried under the new organization's context.
 */

interface WorkspaceRef {
  readonly id: string;
}

/**
 * The workspace the page should use: the user's selection when the active
 * organization has it, otherwise its first workspace, otherwise none ('').
 */
export function resolveActiveWorkspaceId(
  selectedWorkspaceId: string,
  workspaces: readonly WorkspaceRef[],
): string {
  if (selectedWorkspaceId && workspaces.some((ws) => ws.id === selectedWorkspaceId)) {
    return selectedWorkspaceId;
  }
  return workspaces[0]?.id ?? '';
}

/** Keyset pagination history, bound to the workspace it was built for. */
export interface ContactsPager {
  readonly workspaceId: string;
  readonly cursorStack: readonly string[];
}

export const EMPTY_PAGER: ContactsPager = { workspaceId: '', cursorStack: [] };

/** A pager built for another workspace starts again at the first page. */
export function cursorStackFor(pager: ContactsPager, workspaceId: string): readonly string[] {
  return pager.workspaceId === workspaceId ? pager.cursorStack : [];
}
