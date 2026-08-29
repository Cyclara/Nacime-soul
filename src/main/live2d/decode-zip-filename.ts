// src/main/live2d/decode-zip-filename.ts
// ZIP 条目名的历史编码解码。
//
// 来源：对照 AIRI 更新时发现的同类缺陷（moeru-ai/airi#2016，2026-07-20
// `fix(stage-ui-live2d): decode legacy-codepage zip filenames`）。本项目独立实现，
// 结论一致：不能"UTF-8 能解通就用 UTF-8"。
//
// 背景：CJK 作者导出的 Live2D 模型包（尤其 VTube Studio 导出）常常不设 ZIP 的 UTF-8 标志位，
// 条目名按历史代码页（简中最常见 GBK）存储。JSZip 默认按 UTF-8 解，`手姿势切换.exp3.json`
// 会变成 U+FFFD 乱码。
//
// 关键陷阱：**有些 GBK 名同时是合法 UTF-8，但解出来是错字**——GBK 的「一」是字节 `D2 BB`，
// 而这两个字节恰好也是 `һ` 的合法 UTF-8 编码。所以「先试 UTF-8，失败再试 GBK」这种写法
// 会静默产出错字而不是报错。JSZip 只对**未标 UTF-8 标志**的条目调用本函数，因此这里出现的
// 高位字节几乎必然来自历史代码页：纯 ASCII 走快路（两种编码结果相同），其余按 GBK 解。
//
// 必须让所有打开模型压缩包的代码路径共用本函数，否则一条路径看到乱码名、另一条看到正确名，
// 校验与解压会对不上。

/** JSZip `decodeFileName` 选项的实现。 */
export function decodeZipFileName(bytes: string[] | Uint8Array): string {
  // JSZip 传的是原始文件名字节（Uint8Array）；string[] 分支只为满足它的选项签名，原样拼回。
  if (Array.isArray(bytes)) return bytes.join('')

  if (bytes.every((byte) => byte < 0x80)) return new TextDecoder('utf-8').decode(bytes)

  try {
    return new TextDecoder('gbk').decode(bytes)
  } catch {
    // 运行时缺少 GBK 解码器（非 full-icu 构建）时保守回退，至少不比现状更差。
    return new TextDecoder('utf-8').decode(bytes)
  }
}
