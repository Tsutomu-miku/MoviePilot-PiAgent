from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from starlette.background import BackgroundTask


async def proxy_request(runtime, path: str, request: Request, user):
    if not user.super_user:
        raise HTTPException(status_code=403, detail="Pi Agent 仅供管理员使用")
    if path and path != "index.html" and not path.startswith(("assets/", "api/")):
        raise HTTPException(status_code=404, detail="页面不存在")
    if request.method != "GET":
        origin = request.headers.get("origin", "")
        if urlsplit(origin).netloc.lower() != request.headers.get("host", "").lower():
            raise HTTPException(status_code=403, detail="请从 MoviePilot 页面执行操作")
    if runtime is None or runtime.state != "running":
        raise HTTPException(status_code=503, detail="Pi Agent 尚未启动，请查看插件状态")
    body = await request.body()
    if len(body) > 128 * 1024:
        raise HTTPException(status_code=413, detail="请求超过 128 KiB")
    client = httpx.AsyncClient(base_url=runtime.base_url, trust_env=False, timeout=180)
    response = None
    try:
        target = "/" + path
        if request.url.query:
            target += "?" + request.url.query
        upstream = client.build_request(
            request.method,
            target,
            content=body,
            headers={
                "Authorization": "Bearer " + runtime.token,
                "Content-Type": request.headers.get("content-type", "application/json"),
            },
        )
        response = await client.send(upstream, stream=True)
        if path in ("", "index.html") and response.status_code == 200:
            html = (await response.aread()).decode()
            html = html.replace(
                "</head>", '<meta name="pi-agent-host" content="moviepilot" /></head>'
            )
            await response.aclose()
            await client.aclose()
            return HTMLResponse(html)

        async def close():
            await response.aclose()
            await client.aclose()

        return StreamingResponse(
            response.aiter_bytes(),
            status_code=response.status_code,
            headers={
                "Content-Type": response.headers.get("content-type", "application/octet-stream"),
                "Cache-Control": "no-store",
                "X-Accel-Buffering": "no",
            },
            background=BackgroundTask(close),
        )
    except httpx.RequestError as error:
        if response:
            await response.aclose()
        await client.aclose()
        raise HTTPException(status_code=503, detail="Pi Agent 连接失败，请查看插件状态") from error
    except Exception:
        if response:
            await response.aclose()
        await client.aclose()
        raise
