export const STORE_CLOSED_DURING_OPEN_MESSAGE = "Hash store closed while opening";

export interface OpenedStoreResource<T> {
  readonly value: T;
  close(): void;
}

export type StoreLifecyclePhase = "closed" | "opening" | "open" | "closing";

export interface StoreLifecycleDiagnostics {
  readonly phase: StoreLifecyclePhase;
  readonly generation: number;
  readonly opens: number;
  readonly closes: number;
  readonly activePath?: string;
}

export type StoreMaintenanceKind = "health" | "prune";

export interface StoreMaintenanceDiagnostics {
  readonly fullHealthChecks: number;
  readonly pruneRuns: number;
}

interface MaintenanceRegistryV1 {
  readonly schemaVersion: 1;
  readonly healthCheckedPaths: Set<string>;
  readonly prunedPaths: Set<string>;
  readonly healthInFlight: Map<string, Promise<void>>;
  readonly pruneInFlight: Map<string, Promise<void>>;
  fullHealthChecks: number;
  pruneRuns: number;
}

const MAINTENANCE_REGISTRY_KEY = Symbol.for("pi-hashline-edit-pro.maintenance.v1");

function createMaintenanceRegistry(): MaintenanceRegistryV1 {
  return {
    schemaVersion: 1,
    healthCheckedPaths: new Set(),
    prunedPaths: new Set(),
    healthInFlight: new Map(),
    pruneInFlight: new Map(),
    fullHealthChecks: 0,
    pruneRuns: 0,
  };
}

function isMaintenanceRegistry(value: unknown): value is MaintenanceRegistryV1 {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<MaintenanceRegistryV1>;
  return candidate.schemaVersion === 1 &&
    candidate.healthCheckedPaths instanceof Set &&
    candidate.prunedPaths instanceof Set &&
    candidate.healthInFlight instanceof Map &&
    candidate.pruneInFlight instanceof Map &&
    typeof candidate.fullHealthChecks === "number" &&
    typeof candidate.pruneRuns === "number";
}

function maintenanceRegistry(): MaintenanceRegistryV1 {
  const existing = Reflect.get(globalThis, MAINTENANCE_REGISTRY_KEY) as unknown;
  if (isMaintenanceRegistry(existing)) return existing;
  const created = createMaintenanceRegistry();
  Reflect.set(globalThis, MAINTENANCE_REGISTRY_KEY, created);
  return created;
}

export function runStoreMaintenanceOnce(
  kind: StoreMaintenanceKind,
  path: string,
  task: () => void | Promise<void>,
): Promise<void> {
  const registry = maintenanceRegistry();
  const completed = kind === "health" ? registry.healthCheckedPaths : registry.prunedPaths;
  const inFlight = kind === "health" ? registry.healthInFlight : registry.pruneInFlight;
  if (completed.has(path)) return Promise.resolve();
  const existing = inFlight.get(path);
  if (existing) return existing;

  let resolveShared!: () => void;
  let rejectShared!: (reason?: unknown) => void;
  const shared = new Promise<void>((resolve, reject) => {
    resolveShared = resolve;
    rejectShared = reject;
  });
  inFlight.set(path, shared);
  if (kind === "health") registry.fullHealthChecks++;
  else registry.pruneRuns++;

  void Promise.resolve()
    .then(task)
    .then(
      () => {
        completed.add(path);
        if (inFlight.get(path) === shared) inFlight.delete(path);
        resolveShared();
      },
      (error: unknown) => {
        if (inFlight.get(path) === shared) inFlight.delete(path);
        rejectShared(error);
      },
    );
  return shared;
}

export function getStoreMaintenanceDiagnostics(): StoreMaintenanceDiagnostics {
  const registry = maintenanceRegistry();
  return {
    fullHealthChecks: registry.fullHealthChecks,
    pruneRuns: registry.pruneRuns,
  };
}

type ClosedState = {
  readonly kind: "closed";
  readonly generation: number;
};

type OpeningState<T> = {
  readonly kind: "opening";
  readonly generation: number;
  readonly path: string;
  readonly promise: Promise<OpenedStoreResource<T>>;
  readonly setCloseWait: (waitFor: Promise<void>) => void;
};

type OpenState<T> = {
  readonly kind: "open";
  readonly generation: number;
  readonly path: string;
  readonly resource: OpenedStoreResource<T>;
};

type ClosingState = {
  readonly kind: "closing";
  readonly generation: number;
  readonly path: string;
  readonly promise: Promise<void>;
};

type StoreLifecycleState<T> = ClosedState | OpeningState<T> | OpenState<T> | ClosingState;

class StoreResourceCloseError extends Error {
  constructor(readonly closeError: unknown) {
    super("Hash store resource close failed");
  }
}

export class HashStoreLifecycle<T> {
  private state: StoreLifecycleState<T> = { kind: "closed", generation: 0 };
  private opens = 0;
  private closes = 0;
  private shutdownEpoch = 0;

  constructor(private readonly openResource: (path: string) => Promise<OpenedStoreResource<T>>) {}

  load(path: string): Promise<T> {
    const state = this.state;
    if (state.kind === "open") {
      if (state.path === path) return Promise.resolve(state.resource.value);
      return this.loadAfterPathSwitch(path);
    }
    if (state.kind === "opening") {
      if (state.path === path) return this.resourceValue(state.promise);
      return this.loadAfterPathSwitch(path);
    }
    if (state.kind === "closing") {
      return Promise.reject(new Error(STORE_CLOSED_DURING_OPEN_MESSAGE));
    }
    return this.startOpen(path);
  }

  current(): T | undefined {
    return this.state.kind === "open" ? this.state.resource.value : undefined;
  }

  shutdown(waitFor?: Promise<unknown>): Promise<void> {
    this.shutdownEpoch++;
    return this.close(waitFor);
  }

  private loadAfterPathSwitch(path: string): Promise<T> {
    const requestedShutdownEpoch = this.shutdownEpoch;
    return this.closeForPathSwitch().then(() => {
      if (requestedShutdownEpoch !== this.shutdownEpoch) {
        throw new Error(STORE_CLOSED_DURING_OPEN_MESSAGE);
      }
      return this.load(path);
    });
  }

  private closeForPathSwitch(): Promise<void> {
    return this.close();
  }

  private close(waitFor?: Promise<unknown>): Promise<void> {
    const state = this.state;
    if (state.kind === "closed") return Promise.resolve();
    if (state.kind === "closing") return state.promise;

    const closeWait = this.normalizeCloseWait(waitFor);
    const generation = state.generation + 1;
    if (state.kind === "open") {
      const closing = closeWait
        .then(() => this.closeResource(state.resource))
        .finally(() => {
          if (this.state.kind === "closing" && this.state.generation === generation) {
            this.state = { kind: "closed", generation };
          }
        });
      this.state = { kind: "closing", generation, path: state.path, promise: closing };
      return closing;
    }

    state.setCloseWait(closeWait);
    const closing = state.promise
      .then(
        () => undefined,
        (error: unknown) => {
          if (error instanceof StoreResourceCloseError) throw error.closeError;
        },
      )
      .finally(() => {
        if (this.state.kind === "closing" && this.state.generation === generation) {
          this.state = { kind: "closed", generation };
        }
      });
    this.state = { kind: "closing", generation, path: state.path, promise: closing };
    return closing;
  }

  diagnostics(): StoreLifecycleDiagnostics {
    const state = this.state;
    return {
      phase: state.kind,
      generation: state.generation,
      opens: this.opens,
      closes: this.closes,
      ...(state.kind === "closed" ? {} : { activePath: state.path }),
    };
  }

  private startOpen(path: string): Promise<T> {
    const generation = this.state.generation + 1;
    let closeWait = Promise.resolve();
    const setCloseWait = (waitFor: Promise<void>): void => {
      closeWait = waitFor;
    };
    const promise = Promise.resolve().then(() => this.openResource(path)).then(
      (resource) => {
        this.opens++;
        if (this.state.kind === "opening" && this.state.generation === generation) {
          this.state = { kind: "open", generation, path, resource };
          return resource;
        }
        return closeWait.then(() => {
          try {
            this.closeResource(resource);
          } catch (error) {
            throw new StoreResourceCloseError(error);
          }
          throw new Error(STORE_CLOSED_DURING_OPEN_MESSAGE);
        });
      },
      (error: unknown) => {
        if (this.state.kind === "opening" && this.state.generation === generation) {
          this.state = { kind: "closed", generation };
        }
        throw error;
      },
    );
    this.state = { kind: "opening", generation, path, promise, setCloseWait };
    return this.resourceValue(promise);
  }

  private resourceValue(promise: Promise<OpenedStoreResource<T>>): Promise<T> {
    return promise.then(
      (resource) => resource.value,
      (error: unknown) => {
        if (error instanceof StoreResourceCloseError) throw error.closeError;
        throw error;
      },
    );
  }

  private normalizeCloseWait(waitFor?: Promise<unknown>): Promise<void> {
    return waitFor ? waitFor.then(() => undefined, () => undefined) : Promise.resolve();
  }

  private closeResource(resource: OpenedStoreResource<T>): void {
    resource.close();
    this.closes++;
  }
}
