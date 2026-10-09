export function TableNotices({
  cabo,
  skillMessage,
}: {
  cabo?: { callerName: string; remainingTurns: number };
  skillMessage?: string;
}) {
  return (
    <>
      <div aria-hidden="true" className="notice-space" />
      {(cabo || skillMessage) && (
        <div className="table-notices" data-testid="table-notices">
          {cabo && (
            <div
              className="cabo-notice"
              role="status"
              aria-atomic="true"
              data-testid="cabo-notice"
            >
              <div className="cabo-notice-title">
                <img className="icon" src="/icons/cabo.svg" alt="" />
                <strong>{cabo.callerName} 已呼唤 CABO</strong>
                <span>剩余 {cabo.remainingTurns} 人行动</span>
              </div>
              <p>其他玩家各完成一次行动后结算</p>
            </div>
          )}
          {skillMessage && (
            <div
              className="skill-notice"
              role="status"
              data-testid="skill-notice"
            >
              {skillMessage}
            </div>
          )}
        </div>
      )}
    </>
  );
}
