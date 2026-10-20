// 所有页面均为手写的安全合成数据，无真实作品、封面或远程媒体。
export function listing(page = 1, base = "/actor/1/") {
  return `<main><div>全 3 件</div><ul>${(page === 1 ? [1, 2] : [3])
    .map((id) => `<li><a href="/work/TEST-00${id}/"><h3>虚构影片 ${id} · 城市漫步</h3></a></li>`)
    .join("")}</ul>
    ${page === 1 ? `<a href="${base}?page=2">次へ</a>` : ""}</main>`;
}
export function details(code = "TEST-001") {
  return `<main>安全合成作品资料</main><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    {
      props: {
        pageProps: {
          movie: {
            adultVideoId: code,
            title: `${code} · 虚构影片 · 城市漫步`,
            dateOfPublication: "2026-10-10T00:00:00Z",
            summary: "安全合成资料，仅用于功能验证。",
            actor: [{ actor: { name: "示例女演员甲" } }],
            director: { name: "示例导演甲" },
            maker: { name: "示例制作商甲" },
            series: { name: "示例系列甲" },
            genre: [{ name: "旅行" }],
          },
          dmmData: { volume: "90" },
        },
      },
    },
  )}</script>`;
}
