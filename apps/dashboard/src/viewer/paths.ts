import { viewerPath } from "@oa/shared";

/** The chromeless full-screen view of an artifact's current version (#290). */
export const fullPath = (id: string) => `${viewerPath(id)}/full`;
