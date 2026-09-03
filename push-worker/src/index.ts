import { DurableObject } from "cloudflare:workers";
import webpush from "web-push";

export interface Env {
  REST_TIMER: DurableObjectNamespace<RestTimer>;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
  ALLOWED_ORIGIN: string;
}

interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface RestJob {
  subscription: PushSubscriptionJSON;
  warnAt: number;
  doneAt: number;
  exerciseName: string;
  nextLabel: string;
}

function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export class RestTimer extends DurableObject<Env> {
  async schedule(job: RestJob): Promise<void> {
    await this.ctx.storage.put("job", job);
    await this.ctx.storage.setAlarm(job.warnAt);
  }

  async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<RestJob>("job");
    if (!job) return;

    webpush.setVapidDetails(
      this.env.VAPID_SUBJECT,
      this.env.VAPID_PUBLIC_KEY,
      this.env.VAPID_PRIVATE_KEY,
    );

    const now = Date.now();
    const isWarnPhase = now < job.doneAt - 2000;

    try {
      if (isWarnPhase) {
        await webpush.sendNotification(
          job.subscription,
          JSON.stringify({ title: "還有 10 秒", body: `準備：${job.exerciseName}` }),
        );
        await this.ctx.storage.setAlarm(job.doneAt);
      } else {
        await webpush.sendNotification(
          job.subscription,
          JSON.stringify({ title: "時間到！", body: `開始：${job.nextLabel}` }),
        );
        await this.ctx.storage.deleteAll();
      }
    } catch (err) {
      console.error("push send failed", err);
      if (isWarnPhase) await this.ctx.storage.setAlarm(job.doneAt);
      else await this.ctx.storage.deleteAll();
    }
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const headers = corsHeaders(env);
    if (req.method === "OPTIONS") return new Response(null, { headers });

    const url = new URL(req.url);

    if (url.pathname === "/vapid-public-key") {
      return Response.json({ key: env.VAPID_PUBLIC_KEY }, { headers });
    }

    if (url.pathname === "/schedule-rest" && req.method === "POST") {
      const body = await req.json<{
        subscription: PushSubscriptionJSON;
        restSeconds: number;
        exerciseName: string;
        nextLabel: string;
      }>();

      if (!body.subscription?.endpoint || !body.restSeconds) {
        return Response.json({ error: "invalid body" }, { status: 400, headers });
      }

      const now = Date.now();
      const doneAt = now + body.restSeconds * 1000;
      const warnAt = Math.max(now + 1000, doneAt - 10000);

      const id = env.REST_TIMER.newUniqueId();
      const stub = env.REST_TIMER.get(id);
      await stub.schedule({
        subscription: body.subscription,
        warnAt,
        doneAt,
        exerciseName: body.exerciseName,
        nextLabel: body.nextLabel,
      });

      return Response.json({ ok: true }, { headers });
    }

    return new Response("not found", { status: 404, headers });
  },
};
