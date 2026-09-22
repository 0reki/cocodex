#!/usr/bin/env python3
"""Builds a turn-state probe proxy pool from the free proxy lists.

The gateway probes upstream for a fresh `x-codex-turn-state` through the exits
listed in one file (`urlFile` in the turn-state settings), one URL per line, so
this script collects one country's proxies from several lists, keeps the ones
that can actually tunnel to ChatGPT, and writes that file.

    scripts/fetch-proxy-pool.py --out data/proxy-pool.txt

Free lists are mostly stale — they are checked hours or days apart, and what
they check is usually that plain HTTP forwards, not that a TLS tunnel opens.
So the check here is on by default and is the real thing: each candidate has
to complete its own handshake and then a TLS handshake to the target. Expect
single-digit percentages to survive, and expect that to decay within the hour.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import socket
import ssl
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

LIST_URL = "https://proxy.scdn.io/get_proxies.php"
PROXYSCRAPE_URL = "https://api.proxyscrape.com/v4/free-proxy-list/get"
PROXIFLY_URL = "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/{code}/data.txt"
GEONODE_URL = "https://proxylist.geonode.com/api/proxy-list"
# One table row per proxy: the IP and port cells, and the actions cell whose
# button carries the protocols the entry supports.
ROW = re.compile(
    r'<td class="cell-ip">(?P<ip>[^<]+)</td>\s*<td>(?P<port>\d+)</td>.*?'
    r'data-protocols="(?P<protocols>[^"]*)"',
    re.S,
)
# The scheme each advertised protocol is dialled with. They are different
# services, not interchangeable labels: an HTTPS proxy wants TLS to itself,
# a SOCKS one speaks its own handshake, and a host may offer several on the
# same port. The `h`/`a` variants resolve the target through the proxy.
SCHEMES = {
    "HTTP": "http",
    "HTTPS": "https",
    "SOCKS4": "socks4a",
    "SOCKS5": "socks5h",
}


def get(url: str, timeout: float) -> bytes:
    request = urllib.request.Request(
        url, headers={"user-agent": "cocodex-proxy-pool/1", "accept": "*/*"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def normalize(scheme: str, ip: str, port: str | int) -> str | None:
    """`socks5h`/`socks4a` let the proxy resolve the target, which is what a
    probe to a CDN-fronted host wants."""
    scheme = {"socks5": "socks5h", "socks4": "socks4a"}.get(scheme.lower(), scheme.lower())
    if scheme not in {"http", "https", "socks4a", "socks5h"}:
        return None
    return f"{scheme}://{ip}:{port}"


def collect_proxyscrape(code: str, timeout: float) -> list[str]:
    query = urllib.parse.urlencode(
        {
            "request": "display_proxies",
            "country": code.lower(),
            "proxy_format": "protocolipport",
            "format": "text",
        }
    )
    found = []
    for line in get(f"{PROXYSCRAPE_URL}?{query}", timeout).decode().splitlines():
        line = line.strip()
        if "://" not in line:
            continue
        scheme, _, hostport = line.partition("://")
        ip, _, port = hostport.rpartition(":")
        url = normalize(scheme, ip, port)
        if url:
            found.append(url)
    return found


def collect_proxifly(code: str, timeout: float) -> list[str]:
    found = []
    for line in get(PROXIFLY_URL.format(code=code.upper()), timeout).decode().splitlines():
        line = line.strip()
        if "://" not in line:
            continue
        scheme, _, hostport = line.partition("://")
        ip, _, port = hostport.rpartition(":")
        url = normalize(scheme, ip, port)
        if url:
            found.append(url)
    return found


def collect_geonode(code: str, timeout: float) -> list[str]:
    found = []
    page = 1
    while page <= 20:
        query = urllib.parse.urlencode(
            {
                "limit": 500,
                "page": page,
                "sort_by": "lastChecked",
                "sort_type": "desc",
                "country": code.upper(),
            }
        )
        payload = json.loads(get(f"{GEONODE_URL}?{query}", timeout))
        rows = payload.get("data") or []
        for row in rows:
            for protocol in row.get("protocols") or []:
                url = normalize(protocol, row.get("ip"), row.get("port"))
                if url:
                    found.append(url)
        if len(rows) < 500:
            break
        page += 1
    return found


def fetch_page(country: str, per_page: int, page: int, timeout: float) -> dict:
    query = urllib.parse.urlencode(
        {"protocol": "", "country": country, "per_page": per_page, "page": page}
    )
    request = urllib.request.Request(
        f"{LIST_URL}?{query}",
        headers={"accept": "application/json", "user-agent": "cocodex-proxy-pool/1"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def parse_rows(table_html: str) -> list[tuple[str, int, str]]:
    """Every dialable `(ip, port, scheme)` in one page of the table.

    A row may advertise several protocols on one port; each becomes its own
    candidate, because which of them actually answers is not something the
    listing can be trusted about.
    """
    found = []
    for match in ROW.finditer(table_html):
        ip = html.unescape(match.group("ip")).strip()
        port = int(match.group("port"))
        protocols = [p.strip().upper() for p in match.group("protocols").split(",")]
        for protocol in protocols:
            scheme = SCHEMES.get(protocol)
            if scheme:
                found.append((ip, port, scheme))
    return found


def collect(country: str, per_page: int, pages: int | None, timeout: float) -> list[str]:
    seen: dict[str, None] = {}
    page = 1
    total = pages
    while total is None or page <= total:
        try:
            payload = fetch_page(country, per_page, page, timeout)
        except Exception as error:  # noqa: BLE001 - a bad page must not stop the run
            print(f"page {page}: {error}", file=sys.stderr)
            page += 1
            continue
        if total is None:
            total = int(payload.get("totalPages") or 1)
            if pages:
                total = min(total, pages)
        rows = parse_rows(payload.get("table_html") or "")
        for ip, port, scheme in rows:
            seen.setdefault(f"{scheme}://{ip}:{port}", None)
        print(f"page {page}/{total}: {len(rows)} rows, {len(seen)} unique", file=sys.stderr)
        if not rows:
            break
        page += 1
    return list(seen)


def recv_until(raw: socket.socket, terminator: bytes, limit: int = 4096) -> bytes:
    """Reads until the terminator appears. A single `recv` can return half a
    line, which would make a working proxy look dead."""
    data = b""
    while terminator not in data and len(data) < limit:
        chunk = raw.recv(limit - len(data))
        if not chunk:
            break
        data += chunk
    return data


def recv_exactly(raw: socket.socket, count: int) -> bytes:
    data = b""
    while len(data) < count:
        chunk = raw.recv(count - len(data))
        if not chunk:
            break
        data += chunk
    return data


def http_connect(raw: socket.socket, host: str, port: int) -> bool:
    raw.sendall(
        f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n"
        "Proxy-Connection: keep-alive\r\n\r\n".encode()
    )
    return b" 200" in recv_until(raw, b"\r\n").split(b"\r\n")[0]


def socks4a_connect(raw: socket.socket, host: str, port: int) -> bool:
    """A SOCKS4a CONNECT, which passes the hostname to the proxy to resolve."""
    raw.sendall(
        b"\x04\x01"
        + port.to_bytes(2, "big")
        + b"\x00\x00\x00\x01"  # 0.0.0.x marks a SOCKS4a request
        + b"\x00"  # empty user id
        + host.encode()
        + b"\x00"
    )
    reply = recv_exactly(raw, 8)
    return len(reply) >= 2 and reply[1] == 0x5A


def socks5_connect(raw: socket.socket, host: str, port: int) -> bool:
    """A no-auth SOCKS5 CONNECT to a domain, as `socks5h://` dials it."""
    raw.sendall(b"\x05\x01\x00")
    greeting = recv_exactly(raw, 2)
    if greeting[:2] != b"\x05\x00":
        return False
    target = host.encode()
    raw.sendall(
        b"\x05\x01\x00\x03" + bytes([len(target)]) + target + port.to_bytes(2, "big")
    )
    reply = recv_exactly(raw, 4)
    if len(reply) < 4 or reply[1] != 0x00:
        return False
    # Drain the bound address so the stream starts at the tunnelled bytes.
    kind = reply[3] if len(reply) > 3 else 0x01
    length = {0x01: 4, 0x04: 16}.get(kind)
    if length is None:
        length = recv_exactly(raw, 1)[0]
    recv_exactly(raw, length + 2)
    return True


def usable(url: str, host: str, port: int, timeout: float) -> bool:
    """Whether the proxy really carries a TLS connection to the target.

    Each scheme is taken through its own handshake — mixing them is what
    makes a listing look alive when it is not — and then the target's real
    TLS handshake has to complete inside the tunnel. An `https` proxy is
    judged on its CONNECT alone, since the tunnel it returns already sits
    inside the TLS wrapper around the proxy itself.
    """
    parsed = urllib.parse.urlparse(url)
    tunnels = {
        "http": http_connect,
        "https": http_connect,
        "socks4a": socks4a_connect,
        "socks5h": socks5_connect,
    }
    tunnel = tunnels.get(parsed.scheme)
    if tunnel is None:
        return False
    try:
        with socket.create_connection((parsed.hostname, parsed.port), timeout) as raw:
            raw.settimeout(timeout)
            if parsed.scheme == "https":
                # TLS to the proxy first; the CONNECT travels inside it.
                proxy_tls = ssl.create_default_context()
                proxy_tls.check_hostname = False
                proxy_tls.verify_mode = ssl.CERT_NONE
                with proxy_tls.wrap_socket(raw) as wrapped:
                    return tunnel(wrapped, host, port)
            if not tunnel(raw, host, port):
                return False
            context = ssl.create_default_context()
            with context.wrap_socket(raw, server_hostname=host):
                return True
    except Exception:  # noqa: BLE001 - any failure means unusable
        return False


def collect_all(
    sources: list[str], country: str, code: str, per_page: int, pages: int | None, timeout: float
) -> list[str]:
    """Every source's German proxies, merged and deduplicated.

    One list's idea of "alive" is another's dead entry, and each checks a
    different thing (most only that plain HTTP forwards), so the pool is the
    union and the verification decides.
    """
    seen: dict[str, None] = {}
    for name in sources:
        before = len(seen)
        try:
            if name == "scdn":
                urls = collect(country, per_page, pages, timeout)
            elif name == "proxyscrape":
                urls = collect_proxyscrape(code, timeout)
            elif name == "proxifly":
                urls = collect_proxifly(code, timeout)
            elif name == "geonode":
                urls = collect_geonode(code, timeout)
            else:
                print(f"unknown source {name}", file=sys.stderr)
                continue
        except Exception as error:  # noqa: BLE001 - one dead source is not fatal
            print(f"source {name}: {error}", file=sys.stderr)
            continue
        for url in urls:
            seen.setdefault(url, None)
        print(f"source {name}: {len(urls)} listed, {len(seen) - before} new", file=sys.stderr)
    return list(seen)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--country", default="德国", help="country name for the scdn listing")
    parser.add_argument("--country-code", default="DE", help="ISO code for the other sources")
    parser.add_argument(
        "--sources",
        default="scdn,proxyscrape,proxifly,geonode",
        help="comma separated: scdn, proxyscrape, proxifly, geonode",
    )
    parser.add_argument("--per-page", type=int, default=20)
    parser.add_argument("--pages", type=int, help="stop after this many pages")
    parser.add_argument("--out", default="proxy-pool.txt")
    parser.add_argument("--target", default="chatgpt.com:443", help="host:port each proxy must reach")
    parser.add_argument("--timeout", type=float, default=8.0)
    parser.add_argument("--concurrency", type=int, default=64)
    parser.add_argument("--no-check", action="store_true", help="keep every listed proxy")
    parser.add_argument(
        "--schemes",
        default="",
        help=(
            "comma separated schemes to keep (http, https, socks4a, socks5h). "
            "The http ones in these lists are mostly open nginx forwarders "
            "that answer CONNECT with 405, so `socks5h` is usually the only "
            "one worth probing through."
        ),
    )
    args = parser.parse_args()

    sources = [name.strip() for name in args.sources.split(",") if name.strip()]
    candidates = collect_all(
        sources, args.country, args.country_code, args.per_page, args.pages, args.timeout
    )
    print(f"collected {len(candidates)} unique proxies", file=sys.stderr)
    keep = {s.strip().lower() for s in args.schemes.split(",") if s.strip()}
    if keep:
        candidates = [url for url in candidates if url.split("://")[0] in keep]
        print(f"{len(candidates)} of them speak {', '.join(sorted(keep))}", file=sys.stderr)

    if args.no_check:
        alive = candidates
    else:
        host, _, port = args.target.partition(":")
        port = int(port or 443)
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            results = pool.map(lambda url: usable(url, host, port, args.timeout), candidates)
            alive = [url for url, ok in zip(candidates, results) if ok]
        print(f"{len(alive)} of {len(candidates)} reach {args.target}", file=sys.stderr)

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")
    with open(args.out, "w", encoding="utf-8") as file:
        file.write(f"# cocodex turn-state probe exits — {args.country}\n")
        file.write(f"# built {stamp} from {', '.join(sources)}")
        file.write("" if args.no_check else f", verified against {args.target}")
        file.write(f" ({len(alive)}/{len(candidates)})\n")
        for url in alive:
            file.write(f"{url}\n")
    print(f"wrote {len(alive)} proxies to {args.out}", file=sys.stderr)
    return 0 if alive else 1


if __name__ == "__main__":
    raise SystemExit(main())
