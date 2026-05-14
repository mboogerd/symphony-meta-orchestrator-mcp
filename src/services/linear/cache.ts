import type { LinearService } from './index.ts';
import { LinearServiceError } from './index.ts';

export type LinearProjectCacheEntry = {
  teamId: string;
  teamKey: string;
  projectId: string;
  projectSlug: string;
};

export class LinearProjectCache {
  private readonly entries = new Map<string, LinearProjectCacheEntry>();
  private readonly linear: LinearService;
  private readonly teamKey: string;

  constructor(linear: LinearService, teamKey: string) {
    this.linear = linear;
    this.teamKey = teamKey;
  }

  async resolve(name: string): Promise<LinearProjectCacheEntry> {
    const projectName = name.trim();
    const cached = this.entries.get(projectName);
    if (cached !== undefined) {
      return cached;
    }

    const team = await this.linear.resolveTeam(this.teamKey);
    const project = await this.linear.findProjectByNameForTeam(projectName, team.id);
    if (project === undefined) {
      throw new LinearServiceError(
        'project_not_found',
        'resolve_project_cache',
        `Linear project named "${projectName}" was not found in team "${team.key}"`,
        { name: projectName, teamId: team.id, teamKey: team.key }
      );
    }

    const entry = {
      teamId: team.id,
      teamKey: team.key,
      projectId: project.id,
      projectSlug: project.slugId
    };
    this.entries.set(projectName, entry);
    return entry;
  }
}
