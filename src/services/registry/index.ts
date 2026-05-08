export type ProjectRegistry = {
  projects: RegistryProject[];
};

export type RegistryProject = {
  key: string;
  name: string;
  repositoryPath: string;
};

export function createEmptyRegistry(): ProjectRegistry {
  return { projects: [] };
}
