import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import { apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import { Button } from "../ui/Button";
import { BarChart } from "./Charts";
import type { Stat } from "../ui/StatCard";

const bucketSchema = z.object({
  date: z.string(),
  label: z.string(),
  total: z.number().catch(0),
  active: z.number().catch(0),
  dormant: z.number().catch(0),
  pending: z.number().catch(0),
  joined: z.number().catch(0),
});

const growthSchema = z.object({
  period_days: z.number().catch(90),
  step_days: z.number().catch(1),
  buckets: z.array(bucketSchema),
});

export type MetricKey = "total" | "active" | "pending" | "dormant";

const PERIODS = [
  { days: 30, label: "30일" },
  { days: 90, label: "90일" },
  { days: 365, label: "12개월" },
] as const;

const METRIC_BY_LABEL: Readonly<Record<string, MetricKey>> = {
  "전체 구성원": "total",
  활성: "active",
  "초대 대기": "pending",
  "휴면·탈퇴": "dormant",
};

const METRIC_UNIT: Readonly<Record<MetricKey, string>> = {
  total: "명",
  active: "명",
  pending: "건",
  dormant: "명",
};

export function metricKeyOf(stat: Stat, index: number): MetricKey {
  const byLabel = METRIC_BY_LABEL[stat.label];
  if (byLabel) return byLabel;
  return (["total", "active", "pending", "dormant"] as const)[Math.min(index, 3)] ?? "total";
}

type Props = Readonly<{
  stat: Stat;
  metric: MetricKey;
  session: ApiSession | null;
  onClose: () => void;
}>;

/** 지표 자세히 보기: 기간에 따른 인원 변화 폭을 그래프로 보여준다. */
export function StatTrendModal({ stat, metric, session, onClose }: Props) {
  const [days, setDays] = useState<number>(90);
  const [data, setData] = useState<z.infer<typeof growthSchema> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    setData(null);
    setError(null);
    apiRequest(`/members/growth?days=${days}`, { session, signal: controller.signal })
      .then((payload) => {
        if (!controller.signal.aborted) setData(growthSchema.parse(payload));
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(userMessageOf(caught));
      });
    return () => controller.abort();
  }, [session, days]);

  const bars = useMemo(
    () => (data?.buckets ?? []).map((bucket) => ({ label: bucket.label, value: bucket[metric] })),
    [data, metric],
  );

  const first = bars[0]?.value ?? 0;
  const last = bars[bars.length - 1]?.value ?? 0;
  const diff = last - first;
  const rate = first === 0 ? (last === 0 ? 0 : 100) : Math.round((diff / first) * 1000) / 10;
  const peak = bars.reduce((best, bar) => (bar.value > best ? bar.value : best), 0);
  const unit = METRIC_UNIT[metric];

  return (
    <div className="modal-scrim" role="presentation" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stat-trend-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <div>
            <span className="eyebrow">기간별 추이</span>
            <h2 id="stat-trend-title">{stat.label}</h2>
            <p>가입·탈퇴 기록으로 계산한 실제 변화입니다.</p>
          </div>
          <Button tone="neutral" size="small" onClick={onClose} aria-label="닫기">닫기</Button>
        </header>

        <div className="modal__periods" role="tablist" aria-label="기간 선택">
          {PERIODS.map((period) => (
            <button
              key={period.days}
              type="button"
              role="tab"
              aria-selected={days === period.days}
              className={days === period.days ? "chip chip--on" : "chip"}
              onClick={() => setDays(period.days)}
            >
              {period.label}
            </button>
          ))}
        </div>

        {error && <div className="form-error" role="alert">{error}</div>}

        {data === null && !error ? (
          <p className="modal__loading">추이를 불러오는 중입니다…</p>
        ) : bars.length === 0 ? (
          <p className="modal__loading">이 기간에 표시할 기록이 없습니다.</p>
        ) : (
          <>
            <div className="modal__chart">
              <BarChart bars={bars} />
            </div>
            <dl className="modal__summary">
              <div>
                <dt>기간 시작</dt>
                <dd>{first}{unit}</dd>
              </div>
              <div>
                <dt>현재</dt>
                <dd>{last}{unit}</dd>
              </div>
              <div>
                <dt>증감 폭</dt>
                <dd className={diff > 0 ? "up" : diff < 0 ? "down" : undefined}>
                  {diff > 0 ? "+" : ""}{diff}{unit} ({rate > 0 ? "+" : ""}{rate}%)
                </dd>
              </div>
              <div>
                <dt>기간 최고</dt>
                <dd>{peak}{unit}</dd>
              </div>
            </dl>
            <p className="modal__foot">
              막대 하나는 {(data?.step_days ?? 1) === 1 ? "1일" : `${data?.step_days}일`} 구간의 기말 인원입니다.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
