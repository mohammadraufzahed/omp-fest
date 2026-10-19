/**
 * Minimal structural typing for pi.zod so tools compile without depending on
 * the coding-agent package at build time. At runtime the real omptype zod is
 * injected by omp.
 */
export interface ZodSchema {
  optional(): ZodSchema;
  describe(text: string): ZodSchema;
}

export interface ZodLike {
  object(shape: Record<string, ZodSchema>): ZodSchema;
  string(): ZodSchema;
  boolean(): ZodSchema;
  enum(values: readonly string[]): ZodSchema;
  array(item: ZodSchema): ZodSchema;
}
