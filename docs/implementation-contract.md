# dsh 第一版内部接口

这是本次实现的协作契约；公开使用说明另见 readme。Node >=24，ES modules，无前端构建步骤。

## 接收协议

`POST /api/ingest`，`Authorization: Bearer <token>`，JSON：

```json
{
  "source": { "instanceId": "stable-local-dsh-installation", "version": "0.1.6-alpha.2", "label": "dsh", "kind": "live" },
  "sessions": [{ "id": "native-id", "createdAt": 1, "cwd": "/project", "parentSession": "optional", "version": 3 }],
  "events": [{ "sessionId": "native-id", "event": { "type": "turn/start", "seq": 0, "time": 1, "data": { "turn": 1 } }, "historical": false }],
  "gaps": [{ "sessionId": "native-id", "reason": "queue-overflow", "count": 2, "at": 1 }]
}
```

空 arrays 可省略。Source kind = live / import / demo。响应 `{accepted, duplicates, issues, sessionKeys}`。重发按 source instanceId + sessionId + seq 去重；同 seq 不同载荷报冲突，不覆盖。

## 浏览器 API

- `GET /api/status`：`{version, startedAt, dataDir, collector:{lastSeen, connected}, counts:{sessions,events}, connection:{endpoint,tokenFile,pluginPath}, coverage:{...}}`。
- `GET /api/sessions`：`{sessions:[{key,id,sourceId,sourceKind,title,cwd,parentSession,createdAt,lastEventAt,eventCount,errorCount,status,skills:[{name,evidence,count}],gaps:[],...}]}`。
- `GET /api/sessions/:key/events?after=-1&limit=1000`：按 seq 升序 `{events:[normalized], nextAfter, hasMore}`；客户端通过 hasMore 继续分页，不能假定完整记录只有1000条。
- `GET /api/sessions/:key/export`：可下载 Symphony JSON，含 source、session、原始 events 和 gaps；仅导出已保留并脱敏的记录。
- `GET /api/catalog`：`{events:[{type,label,category,description,known}],hooks:[{point,dialects,coverage}], categories:[{id,label}]}`；包含已观察到的未知事件。
- `GET /api/settings` / `PUT /api/settings`：`{audio:{enabled:false,volume:0.35},rules:[{id,enabled:true,match:{type?,category?,hookPoint?,handlerId?,toolName?,skillName?,outcome?},sound:"wood",volume:0.5}],categorySounds:{tool:"wood",hook:"click",...}}`；first matching enabled rule。预置 sounds：wood, glass, bell, low, brush, click, mute；自定义 sound 为上传返回的 `asset:<id>`。
- `POST /api/sounds`：原始音频 bytes，`Content-Type: audio/...`，`X-Filename` URL-encoded；返回 `{sound:"asset:<id>",name,url}`。`GET /api/sounds` 返回 `{sounds:[...]}`。上限5MB。
- `POST /api/import`：Symphony export JSON，或 `{format:"dsh-jsonl",text:"...",sourceId:"..."}`；响应同 ingest。另支持 `Content-Type: application/octet-stream` 原始 dsh v3 JSONL / zstd 文件，`X-Filename`。
- `POST /api/demo`：生成明确标记的多session演示记录；幂等。`POST /api/demo/live`：启动限时演示事件流，响应 `{started:true}`；重复运行先停旧流。
- `GET /api/stream`：SSE `event: update`，`data: {sessionKeys:[], events:[normalized], historical:false}`。心跳 comment。`event: status` 含状态。断线后客户端重新获取 session列表和当前完整事件，补齐不播放。

除 ingest 外，浏览器写操作带 `X-Symphony-Local: 1`；server 校验同源 Origin，禁止跨站。界面不保存或展示 token 值。

## 事件公共结构

domain 模块 `src/events.mjs` 导出 `normalizeEvent(event, context = {})`，context 包含 `{sessionKey,sessionId,sourceId,sourceKind,receivedAt,historical}`。结果保留：

`{id,sessionKey,sessionId,sourceId,sourceKind,seq,type,time,receivedAt,historical,category,label,summary,outcome,phase,turn,step,callId,toolName,hookPoint,handlerId,skillName,skillEvidence,correlationKey,raw}`。

可选字段缺失用 null；outcome=success/failure/blocked/cancelled/unknown；phase=start/end/instant；category=session/model/tool/hook/context/interaction/collaboration/artifact/other。raw 是保留的原始 dsh envelope。Unknown events保留，category other。关联仅用原生ID，不能时间猜测。

`src/events.mjs` 另导出 `summarizeSession(events,header={})` 返回 `{title,status,skills,errorCount}`；`src/catalog.mjs` 导出 `getCatalog(extraTypes=[])`。`src/demo.mjs` 导出 `createDemoBatch(now=Date.now())`，返回 ingest body，含3个session；及 `createLiveDemoFrames(now)` 返回 `{delayMs,batch}[]`，每条使用kind demo并标记。

音频规则匹配在 `public/audio.js`；元数据与原生解析在 domain 模块；Server 不解释声音。声音默认关闭，需点击启用 AudioContext。Session切换取消旧排程，历史补采不触发现场音。记录继续与声音无关。
