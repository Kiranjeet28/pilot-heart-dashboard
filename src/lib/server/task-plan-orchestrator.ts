
export const PLAN_CHUNK_MAX_OUTPUT_TOKENS = 500;
export const PLAN_CHUNK_MAX_COUNT = 8;
export const PLAN_MAX_TOTAL_STEPS = 12;

export interface TaskPlanChunk {
    id: string;
    description: string;
    dependsOn: string[];
}

export interface TaskDecomposition {
    chunks: TaskPlanChunk[];
}

/**
 * Validate the decomposition before it can be used for planning.
 * Chunks describe planning work; they do not execute desktop actions.
 */
export function validateTaskDecomposition(
    value: unknown,
): TaskDecomposition {
    if (!value || typeof value !== "object") {
        throw new Error("Task decomposition must be an object.");
    }

    const candidate = value as { chunks?: unknown };

    if (
        !Array.isArray(candidate.chunks) ||
        candidate.chunks.length === 0 ||
        candidate.chunks.length > PLAN_CHUNK_MAX_COUNT
    ) {
        throw new Error(
            `Task decomposition must contain between 1 and ${PLAN_CHUNK_MAX_COUNT} chunks.`,
        );
    }

    const ids = new Set<string>();

    const chunks = candidate.chunks.map((item, index): TaskPlanChunk => {
        if (!item || typeof item !== "object") {
            throw new Error(`Chunk ${index + 1} must be an object.`);
        }

        const chunk = item as {
            id?: unknown;
            description?: unknown;
            dependsOn?: unknown;
        };

        if (
            typeof chunk.id !== "string" ||
            !/^[a-zA-Z0-9_-]{1,40}$/.test(chunk.id) ||
            ids.has(chunk.id)
        ) {
            throw new Error(`Chunk ${index + 1} has an invalid or duplicate ID.`);
        }

        if (
            typeof chunk.description !== "string" ||
            chunk.description.trim().length === 0 ||
            chunk.description.length > 1000
        ) {
            throw new Error(`Chunk ${index + 1} has an invalid description.`);
        }

        if (
            !Array.isArray(chunk.dependsOn) ||
            !chunk.dependsOn.every(
                (dependency): dependency is string =>
                    typeof dependency === "string",
            )
        ) {
            throw new Error(`Chunk ${index + 1} has invalid dependencies.`);
        }

        ids.add(chunk.id);

        return {
            id: chunk.id,
            description: chunk.description.trim(),
            dependsOn: chunk.dependsOn,
        };
    });

    for (const chunk of chunks) {
        for (const dependency of chunk.dependsOn) {
            if (dependency === chunk.id || !ids.has(dependency)) {
                throw new Error(
                    `Chunk "${chunk.id}" has an invalid dependency "${dependency}".`,
                );
            }
        }
    }

    // Detect dependency cycles.
    const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const visiting = new Set<string>();
    const visited = new Set<string>();

    function visit(id: string): void {
        if (visiting.has(id)) {
            throw new Error("Task chunks contain a dependency cycle.");
        }

        if (visited.has(id)) return;

        visiting.add(id);

        for (const dependency of byId.get(id)?.dependsOn ?? []) {
            visit(dependency);
        }

        visiting.delete(id);
        visited.add(id);
    }

    for (const chunk of chunks) visit(chunk.id);

    return { chunks };
}
