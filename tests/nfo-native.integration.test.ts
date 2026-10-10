import { describe, expect, it, beforeAll } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));
const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
type Metadata = Record<string, unknown>;

describe.runIf(enabled)("NFO 原生兼容读取", () => {
  let root: string;
  beforeAll(async () => {
    await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
    root = await fs.mkdtemp(path.join(project, ".tmp/nfo-fixtures-"));
  });
  async function parse(source: string | Buffer): Promise<Metadata> {
    const file = path.join(root, `${crypto.randomUUID()}.nfo`);
    const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source, "utf8");
    await fs.writeFile(file, bytes);
    let output: string;
    try {
      output = (
        await execute(path.join(project, "bin/javm_database.exe"), ["--nfo-inspect", file], {
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      const result = error as { stdout?: string };
      output = result.stdout ?? "";
    }
    expect((await fs.readFile(file)).equals(bytes)).toBe(true);
    return JSON.parse(output) as Metadata;
  }
  it("旧 JAVM 字段、实体、BOM、CDATA、发行日期及扩展资料保留", async () => {
    const result = await parse(
      '\ufeff<?xml version="1.0" encoding="UTF-8"?><movie><title>合成 &amp; 标题<![CDATA[ / 尾部]]></title><num>TEST-001</num><uniqueid type="local">TEST-001</uniqueid><release>2024/2/29</release><maker>制作方</maker><publisher>发行方</publisher><label>厂牌</label><originalplot>原简介</originalplot><runtime>90</runtime><rating>8.2</rating><actor><name>虚构演员</name><type>Actor</type></actor></movie>',
    );
    expect(result).toMatchObject({
      title: "合成 & 标题 / 尾部",
      num: "TEST-001",
      premiered: "2024-02-29",
      studio: "制作方",
      publisher: "发行方",
      label: "厂牌",
      originalplot: "原简介",
      runtimeSeconds: 5400,
      rating: 8.2,
      actor: ["虚构演员"],
    });
  });
  it("Kodi 结构化评分按 default/max 归一，保留多个站点身份", async () => {
    const result = await parse(
      '<movie><uniqueid type="tmdb" default="true">123</uniqueid><uniqueid type="imdb">tt1234567</uniqueid><ratings><rating name="imdb" max="10"><value>9</value></rating><rating name="javdex" max="5" default="true"><value>4</value><votes>123</votes></rating></ratings><rating>1</rating></movie>',
    );
    expect(result.rating).toBe(8);
    expect(result.uniqueids).toHaveLength(2);
    expect(result).not.toHaveProperty("num");
  });
  it("大小写、嵌套和纯文本演员、演员顺序、两种系列写法", async () => {
    const result = await parse(
      "<Movie><Title>测试</Title><Actors><Actor><Name>乙</Name><Order>2</Order><Thumb>actor.jpg</Thumb></Actor><Actor><Name>甲</Name><Order>0</Order></Actor></Actors><Actor>丙</Actor><Actor><Name>甲</Name></Actor><Set>系列甲</Set><genres><genre>测试分类</genre><genre>测试分类</genre></genres></Movie>",
    );
    expect(result).toMatchObject({
      title: "测试",
      actor: ["甲", "乙", "丙"],
      series: "系列甲",
      genre: ["测试分类"],
    });
    expect(await parse("<movie><set/><set><name>系列乙</name></set></movie>")).toMatchObject({
      series: "系列乙",
    });
  });
  it("分离电影海报、横图、背景与演员头像，保留远程引用但不访问", async () => {
    expect(
      await parse(
        '<movie><thumb aspect="poster">images/poster.jpg</thumb><thumb aspect="landscape">wide.jpg</thumb><fanart><thumb>background.jpg</thumb></fanart><thumb>https://example.invalid/sample.jpg</thumb><actor><name>演员</name><thumb>actor.jpg</thumb></actor></movie>',
      ),
    ).toMatchObject({
      artwork: {
        poster: ["images/poster.jpg"],
        thumb: ["wide.jpg"],
        fanart: ["background.jpg"],
        samples: ["https://example.invalid/sample.jpg"],
      },
    });
  });
  it.each(["90 min", "90 分钟", "01:30:00", "90.0"])("兼容时长 %s", async (value) => {
    expect((await parse(`<movie><runtime>${value}</runtime></movie>`)).runtimeSeconds).toBe(5400);
  });
  it("fileinfo 的秒数优先于 runtime，宽高作为缺失时的后备", async () => {
    expect(
      await parse(
        "<movie><runtime>90</runtime><fileinfo><streamdetails><video><durationinseconds>123.5</durationinseconds><width>1920</width><height>1080</height></video></streamdetails></fileinfo></movie>",
      ),
    ).toMatchObject({ runtimeSeconds: 124, width: 1920, height: 1080 });
  });
  it("修复裸 & 和非法控制字符，CDATA 不重复解码", async () => {
    expect(
      await parse(
        "<movie><title>A & B\u0001</title><plot><![CDATA[<p>A &amp; B</p>]]></plot><website>https://example.invalid/?a=1&b=2</website></movie>",
      ),
    ).toMatchObject({
      title: "A & B",
      plot: "<p>A &amp; B</p>",
      website: "https://example.invalid/?a=1&b=2",
    });
  });
  it("保留有效数字实体，未知或非法实体按字面内容读取", async () => {
    expect(
      await parse("<movie><title>&#20013;&#x6587; &custom; &#0; &#x110000;</title></movie>"),
    ).toMatchObject({ title: "中文 &custom; &#0; &#x110000;" });
  });
  it("允许根节点外的注释及空白", async () => {
    expect(
      await parse("\n<!-- before --><movie><title>测试</title></movie><!-- after -->\n"),
    ).toMatchObject({ title: "测试" });
  });
  it("UTF-16 BE/LE 与 UTF-32 编码", async () => {
    const source = "\ufeff<movie><title>中文测试</title></movie>";
    for (const bytes of [Buffer.from(source, "utf16le"), Buffer.from(source, "utf16le").swap16()])
      expect((await parse(bytes)).title).toBe("中文测试");
    const points = Array.from(source);
    const utf32 = Buffer.alloc(points.length * 4);
    points.forEach((ch, i) => utf32.writeUInt32BE(ch.codePointAt(0)!, i * 4));
    expect((await parse(utf32)).title).toBe("中文测试");
  });
  it("按声明读取 GB2312，未声明的 GB18030 回退必须提示", async () => {
    const body = Buffer.concat([
      Buffer.from("<movie><title>"),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
      Buffer.from("</title></movie>"),
    ]);
    expect(
      await parse(Buffer.concat([Buffer.from('<?xml version="1.0" encoding="GB2312"?>'), body])),
    ).toMatchObject({ title: "中文", _encoding: "gb2312" });
    const result = await parse(body);
    expect(result.title).toBe("中文");
    expect(result._warnings).toEqual(expect.arrayContaining([expect.stringContaining("GB18030")]));
  });
  it("无效数字、日期和 IMDb id 不误用，保留 year 后备", async () => {
    const result = await parse(
      "<movie><id>tt1234567</id><rating>NaN</rating><runtime>90garbage</runtime><premiered>2023-02-29</premiered><year>2023</year></movie>",
    );
    expect(result).not.toHaveProperty("rating");
    expect(result).not.toHaveProperty("runtimeSeconds");
    expect(result).not.toHaveProperty("premiered");
    expect(result).not.toHaveProperty("num");
    expect(result.year).toBe(2023);
  });
  it.each([
    "<movie><title>截断",
    "<movie/><movie/>",
    "garbage<movie/>",
    "<movie/>garbage",
    "<tvshow><title>不是电影</title></tvshow>",
    '<!DOCTYPE movie [<!ENTITY x SYSTEM "file:///not-accessed">]><movie><title>&x;</title></movie>',
    `<movie>${"<x>".repeat(70)}${"</x>".repeat(70)}</movie>`,
  ])("不猜测修补结构性损坏或 DTD（%#）", async (source) => {
    expect(await parse(source)).toHaveProperty("error");
  });
  it("拒绝超限 NFO", async () => {
    expect(await parse("<movie>" + " ".repeat(2 * 1024 * 1024) + "</movie>")).toHaveProperty(
      "error",
    );
  });
});
