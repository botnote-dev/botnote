import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type {
  CreateProjectInput,
  CreateWorklogEntryInput,
  EntityKind,
  ListFeedbackInput,
  RecentInput,
  RecurrenceInput,
  SearchInput,
  SplitRecurrenceInput,
  TasksRangeInput,
  Token,
  UpdateEmbeddingSettingsInput,
  UpdateEntityInput,
  UpdateProjectInput,
  UpdateWorkspaceSettingsInput,
  WriteEntityInput
} from "./types";

export const POLL_INTERVAL = 30_000;

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    staleTime: 5 * 60_000
  });
}

export function useProjects(opts: { includeArchived?: boolean } = {}) {
  const includeArchived = Boolean(opts.includeArchived);
  return useQuery({
    queryKey: ["projects", includeArchived],
    queryFn: () => api.listProjects({ includeArchived })
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ["project", id],
    queryFn: () => api.getProject(id!),
    enabled: Boolean(id)
  });
}

export function useProjectByKey(key: string | undefined) {
  return useQuery({
    queryKey: ["project", "by-key", key],
    queryFn: () => api.getProjectByKey(key!),
    enabled: Boolean(key)
  });
}

export function useOpeningBrief(projectId: string | undefined, opts: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: ["opening-brief", projectId],
    queryFn: () => api.openingBrief(projectId!),
    enabled: Boolean(projectId),
    refetchInterval: opts.poll === false ? false : POLL_INTERVAL
  });
}

export function useEntity(id: string | undefined) {
  return useQuery({
    queryKey: ["entity", id],
    queryFn: () => api.getEntity(id!),
    enabled: Boolean(id)
  });
}

export function useEntityRevisions(id: string | undefined, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["revisions", id],
    queryFn: () => api.entityRevisions(id!),
    enabled: Boolean(id) && (opts.enabled ?? true)
  });
}

/** Sub-tasks and linked memory of an entity (parentId or parent_of edges). */
export function useChildEntities(id: string | undefined) {
  return useQuery({
    queryKey: ["children", id],
    queryFn: () => api.childEntities(id!),
    enabled: Boolean(id)
  });
}

/** Worklog entries on an entity, oldest first. */
export function useWorklog(id: string | undefined, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["worklog", id],
    queryFn: () => api.listWorklog(id!),
    enabled: Boolean(id) && (opts.enabled ?? true)
  });
}

export function useAddWorklogEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ parentId, input }: { parentId: string; input: CreateWorklogEntryInput }) =>
      api.addWorklogEntry(parentId, input),
    onSuccess: (entry, { parentId }) => {
      qc.invalidateQueries({ queryKey: ["worklog", parentId] });
      qc.invalidateQueries({ queryKey: ["opening-brief", entry.projectId ?? undefined] });
      qc.invalidateQueries({ queryKey: ["recent"] });
    }
  });
}

export function useRecent(input: RecentInput, opts: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: ["recent", input],
    queryFn: () => api.recent(input),
    refetchInterval: opts.poll === false ? false : POLL_INTERVAL
  });
}

export function useEntityList(
  projectId: string | undefined,
  kinds: EntityKind[] | null,
  opts: { poll?: boolean } = {}
) {
  return useQuery({
    queryKey: ["entity-list", projectId, kinds],
    queryFn: () =>
      api.recent({
        projectId: projectId ?? null,
        kinds: kinds ?? null,
        limit: 100
      }),
    enabled: Boolean(projectId),
    refetchInterval: opts.poll === false ? false : POLL_INTERVAL
  });
}

export function useSearch(input: SearchInput | null) {
  return useQuery({
    queryKey: ["search", input],
    queryFn: () => api.search(input!),
    enabled: Boolean(input && input.query.length > 0)
  });
}

export function useFeedback(input: ListFeedbackInput = {}, opts: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: ["feedback", input],
    queryFn: () => api.listFeedback(input),
    refetchInterval: opts.poll === false ? false : POLL_INTERVAL
  });
}

export function useTrash(limit = 100) {
  return useQuery({
    queryKey: ["trash", limit],
    queryFn: () => api.listTrash(limit)
  });
}

const TRASH_AFFECTED_KEYS = [
  ["trash"],
  ["tasks-range"],
  ["recent"],
  ["entity-list"],
  ["feedback"]
] as const;

export function useRestoreEntity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.restoreEntity(id),
    onSuccess: () => {
      for (const key of TRASH_AFFECTED_KEYS) qc.invalidateQueries({ queryKey: key });
    }
  });
}

export function usePurgeEntity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.purgeEntity(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trash"] });
    }
  });
}

export function useEmbeddingSettings() {
  return useQuery({
    queryKey: ["settings", "embedding"],
    queryFn: api.getEmbeddingSettings,
    refetchInterval: POLL_INTERVAL
  });
}

export function useUpdateEmbeddingSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateEmbeddingSettingsInput) => api.updateEmbeddingSettings(input),
    onSuccess: (settings) => {
      qc.setQueryData(["settings", "embedding"], settings);
      qc.invalidateQueries({ queryKey: ["health"] });
    }
  });
}

export function useBackfillEmbeddings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (limit?: number) => api.backfillEmbeddings(limit),
    onSuccess: (result) => {
      qc.setQueryData(["settings", "embedding"], result.settings);
    }
  });
}

export function useWorkspaceSettings() {
  return useQuery({
    queryKey: ["settings", "workspace"],
    queryFn: api.getWorkspaceSettings
  });
}

export function useUpdateWorkspaceSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateWorkspaceSettingsInput) => api.updateWorkspaceSettings(input),
    onSuccess: (settings) => {
      qc.setQueryData(["settings", "workspace"], settings);
    }
  });
}

export function useTasksRange(input: TasksRangeInput, opts: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: ["tasks-range", input],
    queryFn: () => api.tasksRange(input),
    refetchInterval: opts.poll === false ? false : POLL_INTERVAL
  });
}

export function useRecurrence(taskId: string | undefined) {
  return useQuery({
    queryKey: ["recurrence", taskId],
    queryFn: () => api.getRecurrence(taskId!),
    enabled: Boolean(taskId),
    retry: false
  });
}

export function useConfigureRecurrence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, input }: { taskId: string; input: RecurrenceInput }) =>
      api.configureRecurrence(taskId, input),
    onSuccess: (rule) => {
      qc.invalidateQueries({ queryKey: ["entity", rule.currentOccurrenceId ?? undefined] });
      qc.invalidateQueries({ queryKey: ["recurrence"] });
      qc.invalidateQueries({ queryKey: ["tasks-range"] });
      qc.invalidateQueries({ queryKey: ["recent"] });
      qc.invalidateQueries({ queryKey: ["entity-list"] });
    }
  });
}

export function useSkipOccurrence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, reason }: { taskId: string; reason?: string }) =>
      api.skipOccurrence(taskId, reason),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["entity", result.skipped.id] });
      if (result.next) qc.invalidateQueries({ queryKey: ["entity", result.next.id] });
      qc.invalidateQueries({ queryKey: ["recurrence"] });
      qc.invalidateQueries({ queryKey: ["tasks-range"] });
      qc.invalidateQueries({ queryKey: ["recent"] });
      qc.invalidateQueries({ queryKey: ["entity-list"] });
    }
  });
}

export function useStopRecurrence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, reason }: { ruleId: string; reason?: string }) =>
      api.stopRecurrence(ruleId, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recurrence"] });
      qc.invalidateQueries({ queryKey: ["tasks-range"] });
      qc.invalidateQueries({ queryKey: ["recent"] });
      qc.invalidateQueries({ queryKey: ["entity-list"] });
    }
  });
}

export function useSplitRecurrence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, input }: { ruleId: string; input: SplitRecurrenceInput }) =>
      api.splitRecurrence(ruleId, input),
    onSuccess: (rule) => {
      qc.invalidateQueries({ queryKey: ["entity", rule.currentOccurrenceId ?? undefined] });
      qc.invalidateQueries({ queryKey: ["recurrence"] });
      qc.invalidateQueries({ queryKey: ["tasks-range"] });
      qc.invalidateQueries({ queryKey: ["recent"] });
      qc.invalidateQueries({ queryKey: ["entity-list"] });
    }
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => api.createProject(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
    }
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, fields }: { id: string; fields: UpdateProjectInput }) =>
      api.updateProject(id, fields),
    onSuccess: (project) => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.setQueryData(["project", project.id], project);
      qc.invalidateQueries({ queryKey: ["project", "by-key", project.key] });
      qc.invalidateQueries({ queryKey: ["opening-brief", project.id] });
    }
  });
}

export function useWriteEntity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WriteEntityInput) => api.writeEntity(input),
    onSuccess: (entity) => {
      qc.invalidateQueries({ queryKey: ["entity-list", entity.projectId ?? undefined] });
      qc.invalidateQueries({ queryKey: ["opening-brief", entity.projectId ?? undefined] });
      qc.invalidateQueries({ queryKey: ["recent"] });
      qc.invalidateQueries({ queryKey: ["tasks-range"] });
      if (entity.parentId) {
        qc.invalidateQueries({ queryKey: ["children", entity.parentId] });
      }
    }
  });
}

export function useUpdateEntity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, fields }: { id: string; fields: UpdateEntityInput }) =>
      api.updateEntity(id, fields),
    onSuccess: (entity) => {
      qc.invalidateQueries({ queryKey: ["entity", entity.id] });
      qc.invalidateQueries({ queryKey: ["entity-list", entity.projectId ?? undefined] });
      qc.invalidateQueries({ queryKey: ["opening-brief", entity.projectId ?? undefined] });
      qc.invalidateQueries({ queryKey: ["tasks-range"] });
      qc.invalidateQueries({ queryKey: ["children"] });
      qc.invalidateQueries({ queryKey: ["revisions", entity.id] });
      if (entity.kind === "feedback") qc.invalidateQueries({ queryKey: ["feedback"] });
    }
  });
}

export function useDeleteEntity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteEntity(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks-range"] });
      qc.invalidateQueries({ queryKey: ["recent"] });
      qc.invalidateQueries({ queryKey: ["entity-list"] });
      qc.invalidateQueries({ queryKey: ["opening-brief"] });
      qc.invalidateQueries({ queryKey: ["children"] });
    }
  });
}

/** Convenience wrapper around useUpdateProject for the AGENTS.md editor. */
export function useSetAgentsMd() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, agentsMd }: { id: string; agentsMd: string }) =>
      api.updateProject(id, { agentsMd }),
    onSuccess: (project) => {
      qc.invalidateQueries({ queryKey: ["project", "by-key", project.key] });
      qc.invalidateQueries({ queryKey: ["opening-brief", project.id] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    }
  });
}

export function useTokens() {
  return useQuery({
    queryKey: ["tokens"],
    queryFn: api.listTokens
  });
}

export function useCreateToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.createToken(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tokens"] });
    }
  });
}

export function useRevokeToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeToken(id),
    onSuccess: (_data, id) => {
      qc.setQueryData<Token[]>(["tokens"], (rows) => rows?.filter((t) => t.id !== id) ?? rows);
      qc.invalidateQueries({ queryKey: ["tokens"], refetchType: "active" });
    }
  });
}
