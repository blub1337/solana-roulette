/** TEMPORARY UI check (deleted after the run): server-renders RefundChoice. */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RefundChoice } from "../components/RefundChoice";

const pending = {
  active: true,
  status: "pending" as const,
  openMs: 45_000,
  deadline: Date.now() + 90_000,
  msRemaining: 90_000,
  windowMs: 120_000,
  canRefund: true,
  canWait: true,
};

describe("RefundChoice markup", () => {
  it("asks a participant to choose refund or wait, showing their stake", () => {
    const html = renderToStaticMarkup(
      <RefundChoice
        roundId="42"
        refundWindow={pending}
        myStakeLamports="100000000"
        isParticipant={true}
        onResolved={() => {}}
      />
    );
    expect(html).toContain("Do you want your SOL back?");
    expect(html).toContain("0.1");
    expect(html).toContain("Refund my");
    expect(html).toContain("keep waiting");
    expect(html).toContain("1:30");
  });

  it("gives a non-participant neutral wording without a personal refund button", () => {
    const html = renderToStaticMarkup(
      <RefundChoice
        roundId="42"
        refundWindow={pending}
        myStakeLamports={null}
        isParticipant={false}
        onResolved={() => {}}
      />
    );
    expect(html).toContain("deciding what to do");
    expect(html).not.toContain("Refund my");
  });

  it("renders nothing when no decision window is open", () => {
    const html = renderToStaticMarkup(
      <RefundChoice
        roundId="42"
        refundWindow={null}
        myStakeLamports="100000000"
        isParticipant={true}
        onResolved={() => {}}
      />
    );
    expect(html).toBe("");
  });
});