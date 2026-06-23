import { DEFAULT_PROJECT } from './examples';

/** The in-browser project: a set of named files persisted to localStorage. */
export interface ProjectState {
  files: Record<string, string>;
  active: string;
}

const KEY = 'compy.project.v1';

export function loadProject(): ProjectState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as ProjectState;
      if (p.files && p.active && p.files[p.active] !== undefined) return p;
    }
  } catch {
    /* ignore corrupt storage */
  }
  return { files: { ...DEFAULT_PROJECT }, active: 'main.c' };
}

export function saveProject(p: ProjectState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage full / unavailable */
  }
}

export function addFile(p: ProjectState, name: string): ProjectState {
  if (p.files[name] !== undefined) return { ...p, active: name };
  const isHeader = name.endsWith('.h');
  const stub = isHeader
    ? `#ifndef ${headerGuard(name)}\n#define ${headerGuard(name)}\n\n#endif\n`
    : `#include <stdio.h>\n\nvoid ${baseName(name)}(void) {\n}\n`;
  return { files: { ...p.files, [name]: stub }, active: name };
}

export function removeFile(p: ProjectState, name: string): ProjectState {
  if (Object.keys(p.files).length <= 1) return p;
  const files = { ...p.files };
  delete files[name];
  const active = p.active === name ? Object.keys(files)[0]! : p.active;
  return { files, active };
}

export function renameFile(p: ProjectState, from: string, to: string): ProjectState {
  if (p.files[to] !== undefined || p.files[from] === undefined) return p;
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.files)) files[k === from ? to : k] = v;
  return { files, active: p.active === from ? to : p.active };
}

function headerGuard(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
}
function baseName(name: string): string {
  return name.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_]/g, '_');
}
