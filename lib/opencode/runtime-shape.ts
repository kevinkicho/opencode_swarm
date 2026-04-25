// Runtime shape checks for opencode HTTP responses — task #81.
//
// We talk to opencode's internal HTTP API. The TS types in ./types are
// our best understanding, refined by probes; opencode itself doesn't
// publish a contract. If they rename a field, drop a key, or change
// an array to a singleton, our `as Foo` casts in the call sites would
// silently produce wrong-shape data that crashes much later (an
// undefined .map(), a missing .id, a NaN comparison).
//
// `parseOpencodeJSON` is the choke point: a predicate runs at the
// HTTP boundary, throws with a clear context string on shape drift,
// and returns the typed value. Cheap (single object inspection per
// response, no external deps) and catches the silent-contract class
// at the moment of impact rather than three layers up.
//
// Validators here are deliberately *thin*. We don't validate every
// field — that would be a maintenance burden + zod-shaped overkill.
// We validate the shape's shape: array vs object, presence of the
// 1–3 fields the call site actually depends on. That's enough to
// catch a rename or a wholesale API change while staying lightweight.

export type ShapeValidator<T> = (body: unknown) => body is T;

// Build a validator that requires `body` to be an object with all
// listed fields present (any value, including nullish — we're checking
// shape, not nullability). Use this for individual records.
export function hasFields<T>(...fields: ReadonlyArray<keyof T & string>): ShapeValidator<T> {
  return (body: unknown): body is T => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const obj = body as Record<string, unknown>;
    for (const f of fields) {
      if (!(f in obj)) return false;
    }
    return true;
  };
}

// Build a validator that requires `body` to be an array whose every
// element matches `itemCheck`. Empty arrays trivially pass — we
// can't fingerprint a shape from zero samples and don't want to
// throw on a legitimately empty response (e.g. fresh project with
// no sessions yet).
export function isArrayOf<T>(itemCheck: ShapeValidator<T>): ShapeValidator<T[]> {
  return (body: unknown): body is T[] => {
    if (!Array.isArray(body)) return false;
    for (const item of body) {
      if (!itemCheck(item)) return false;
    }
    return true;
  };
}

// Run a Response through json() then validate. Throws with the request
// context (path) on shape drift so the caller doesn't have to add
// boilerplate. The thrown error names the FIRST sample that failed,
// trimmed to keep the error message readable.
export async function parseOpencodeJSON<T>(
  res: Response,
  validate: ShapeValidator<T>,
  context: string,
): Promise<T> {
  const body = await res.json();
  if (!validate(body)) {
    const sample = JSON.stringify(body).slice(0, 200);
    throw new Error(
      `opencode shape mismatch at ${context} — body did not pass validator. Sample (first 200 chars): ${sample}`,
    );
  }
  return body;
}
