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
  doneAt: number;
  warned: boolean;
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

const WARN_LEAD_MS = 10_000;

function alarmTimeFor(job: RestJob): number {
  return job.warned ? job.doneAt : job.doneAt - WARN_LEAD_MS;
}

export class RestTimer extends DurableObject<Env> {
  async schedule(job: Omit<RestJob, "warned">): Promise<void> {
    const now = Date.now();
    const full: RestJob = { ...job, warned: job.doneAt - now <= WARN_LEAD_MS };
    await this.ctx.storage.put("job", full);
    await this.ctx.storage.setAlarm(Math.max(now + 500, alarmTimeFor(full)));
  }

  async reschedule(deltaSeconds: number): Promise<{ ok: boolean }> {
    const job = await this.ctx.storage.get<RestJob>("job");
    if (!job) return { ok: false };
    const now = Date.now();
    job.doneAt = Math.max(now + 1000, job.doneAt + deltaSeconds * 1000);
    job.warned = job.doneAt - now <= WARN_LEAD_MS;
    await this.ctx.storage.put("job", job);
    await this.ctx.storage.setAlarm(Math.max(now + 500, alarmTimeFor(job)));
    return { ok: true };
  }

  async cancel(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<RestJob>("job");
    if (!job) return;

    webpush.setVapidDetails(
      this.env.VAPID_SUBJECT,
      this.env.VAPID_PUBLIC_KEY,
      this.env.VAPID_PRIVATE_KEY,
    );

    try {
      if (!job.warned) {
        await webpush.sendNotification(
          job.subscription,
          JSON.stringify({ title: "還有 10 秒", body: `準備：${job.exerciseName}` }),
        );
        job.warned = true;
        await this.ctx.storage.put("job", job);
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
      await this.ctx.storage.deleteAll();
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

      const doneAt = Date.now() + body.restSeconds * 1000;
      const id = env.REST_TIMER.newUniqueId();
      const stub = env.REST_TIMER.get(id);
      await stub.schedule({
        subscription: body.subscription,
        doneAt,
        exerciseName: body.exerciseName,
        nextLabel: body.nextLabel,
      });

      return Response.json({ ok: true, id: id.toString() }, { headers });
    }

    if (url.pathname === "/reschedule-rest" && req.method === "POST") {
      const body = await req.json<{ id: string; deltaSeconds: number }>();
      if (!body.id || typeof body.deltaSeconds !== "number") {
        return Response.json({ error: "invalid body" }, { status: 400, headers });
      }
      const stub = env.REST_TIMER.get(env.REST_TIMER.idFromString(body.id));
      const result = await stub.reschedule(body.deltaSeconds);
      return Response.json(result, { headers });
    }

    if (url.pathname === "/cancel-rest" && req.method === "POST") {
      const body = await req.json<{ id: string }>();
      if (!body.id) return Response.json({ error: "invalid body" }, { status: 400, headers });
      const stub = env.REST_TIMER.get(env.REST_TIMER.idFromString(body.id));
      await stub.cancel();
      return Response.json({ ok: true }, { headers });
    }

    return new Response("not found", { status: 404, headers });
  },
};
