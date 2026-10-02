import { invoke } from "@tauri-apps/api/core";

export interface VaultNode {
  name: string;
  path: string;
  kind: "dir" | "file" | string;
  children?: VaultNode[] | null;
}

export interface VaultInfo {
  root: string;
  name: string;
  tree: VaultNode;
  fileCount: number;
  truncated?: boolean;
}

export interface SearchHit {
  path: string;
  name: string;
  line: number;
  preview: string;
}

export interface BacklinkHit {
  path: string;
  name: string;
  line: number;
  preview: string;
}

export interface TagInfo {
  tag: string;
  count: number;
  paths: string[];
}

export interface QueryHit {
  path: string;
  name: string;
}

export async function openVault(root: string): Promise<VaultInfo> {
  return invoke<VaultInfo>("open_vault", { root });
}

export async function searchVault(
  root: string,
  query: string,
): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("search_vault", { root, query });
}

export async function findBacklinks(
  root: string,
  notePath: string,
): Promise<BacklinkHit[]> {
  return invoke<BacklinkHit[]>("find_backlinks", { root, notePath });
}

export async function listVaultTags(root: string): Promise<TagInfo[]> {
  return invoke<TagInfo[]>("list_vault_tags", { root });
}

export async function queryVault(
  root: string,
  query: string,
): Promise<QueryHit[]> {
  return invoke<QueryHit[]>("query_vault", { root, query });
}
