import { type Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import type { ProjectionDefinition, SessionProjectionMap, SessionProjectionStateMap } from '@deepseek-ai/dsh-session-projection';
type BaseState = SessionProjectionStateMap['contextPressure'];
type View = SessionProjectionMap['contextPressure'];
type PressureDefinition = ProjectionDefinition<'contextPressure'> & {
    wire: NonNullable<ProjectionDefinition<'contextPressure'>['wire']>;
};
declare const extraSchema: z.ZodObject<{
    header: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        model: z.ZodString;
        fingerprint: z.ZodString;
        tools: z.ZodNumber;
    }, z.core.$strict>>;
    sample: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        model: z.ZodString;
        fingerprint: z.ZodString;
        tools: z.ZodNumber;
    }, z.core.$strict>>;
    sampleNative: z.ZodNullable<z.ZodBoolean>;
    nativeHistory: z.ZodBoolean;
    context: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        model: z.ZodString;
    }, z.core.$strict>>;
    nodes: z.ZodArray<z.ZodObject<{
        seq: z.ZodPipe<z.ZodNumber, z.ZodTransform<SessionSeq, number>>;
        position: z.ZodPipe<z.ZodNumber, z.ZodTransform<SessionSeq, number>>;
        provider: z.ZodString;
        tokens: z.ZodNumber;
    }, z.core.$strict>>;
    positions: z.ZodArray<z.ZodObject<{
        seq: z.ZodPipe<z.ZodNumber, z.ZodTransform<SessionSeq, number>>;
        position: z.ZodPipe<z.ZodNumber, z.ZodTransform<SessionSeq, number>>;
    }, z.core.$strict>>;
    sampledHidden: z.ZodRecord<z.ZodString, z.ZodNumber>;
}, z.core.$strict>;
type Extra = z.infer<typeof extraSchema> & {
    view: View;
};
type State = BaseState & {
    codex: Extra;
};
/**
 * Withhold only the host pressure registration in an isolated service view.
 * All other registrations use the original caller-traced registry and disposer.
 * @param ctx - scope owning the replacement meter.
 * @returns scoped constructor context and the captured host pressure definition.
 */
export declare function capturePressureRegistration(ctx: Context): {
    context: Context;
    readonly definition: PressureDefinition;
    register<S extends BaseState>(definition: ProjectionDefinition<'contextPressure', S>): () => void;
};
/**
 * Add hidden replay to the existing UI pressure fields using only logged data.
 * Native groups are immutable policy; source prices and sample totals stay
 * policy-independent so checkpoints can be safely restored after ownership changes.
 * @param base - host pressure fold, schema, and wire view.
 * @param groups - provider routes grouped by their active native adapter.
 * @returns one pure pressure unit with a policy-independent checkpoint format.
 */
export declare function codexPressureProjection(base: PressureDefinition, groups: readonly (readonly string[])[]): ProjectionDefinition<'contextPressure', State> & {
    wire: NonNullable<ProjectionDefinition<'contextPressure', State>['wire']>;
};
export {};
