/** Codex hidden-replay pricing layered over the host's ordinary token meter. */
import { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import type { TokenMeasurement, TokenMeterConfig } from '@deepseek-ai/dsh-token-meter';
import type { Context } from '@deepseek-ai/cordis';
import type { EpochHeader, Session } from '@deepseek-ai/dsh-session';
/**
 * Replacement tokenMeter service that charges native Codex encrypted reasoning.
 * Ordinary prices, usage, and breakdown projections come from the host meter.
 * The UI pressure unit adds the same hidden pricing per logged request route. Hidden prices apply
 * only between routes currently owned by the same native adapter; fixed
 * heuristicTokens stay unchanged. Provider usage is not charged a second time.
 */
export declare class CodexTokenMeter extends TokenMeter {
    static inject: string[];
    private readonly hiddenFolds;
    constructor(ctx: Context, config?: TokenMeterConfig);
    /**
     * Return a detached measurement including opaque native replay in node prices,
     * surface totals, and signed anchor deltas. Recheck usage conservatism against
     * the corrected full anchor before reusing the provider sample.
     * @param session - session to price through its current durable tail.
     * @param requestHeader - optional effective routed request envelope.
     * @returns immutable request pressure and positional message prices.
     */
    measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement;
    /** Track only replay metadata and surface positions; the host validates each event first. */
    private syncHidden;
    private foldHidden;
}
export default CodexTokenMeter;
