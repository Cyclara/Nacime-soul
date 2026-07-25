// src/main/prompts/loader.ts
// P1-21: Prompt 文件加载器
// 依据：S-001 P1-21、技术分析 §2.3（Cyrene-Agent 5 层静态模块化组装）
//
// 设计要点：
//   1. PromptLoader 接口抽象文件读取，便于测试注入 fake loader
//   2. 生产用 createFilePromptLoader 从 resources/prompts/ 读取
//   3. load() 返回 string | null：null = 文件不存在，不抛异常
//   4. 不依赖 electron（路径由调用方传入），遵循"读写数据的函数不 import electron"

import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Prompt 文件加载器接口。
 * load(name) 返回文件内容字符串，文件不存在时返回 null。
 */
export interface PromptLoader {
  /** 加载指定相对路径的 prompt 文件。返回 null = 文件不存在。 */
  load(relativePath: string): string | null
}

/**
 * 基于文件系统的 PromptLoader。
 * 从 promptsDir 读取 prompt 文件，文件不存在返回 null。
 *
 * 路径安全：只允许读取 promptsDir 内的文件（防止路径穿越）。
 */
export function createFilePromptLoader(promptsDir: string): PromptLoader {
  return {
    load(relativePath: string): string | null {
      // 规范化路径，防止路径穿越（如 ../../../etc/passwd）
      const resolved = path.resolve(promptsDir, relativePath)
      const normalizedDir = path.resolve(promptsDir)
      if (!resolved.startsWith(normalizedDir + path.sep) && resolved !== normalizedDir) {
        return null
      }

      try {
        return fs.readFileSync(resolved, 'utf-8')
      } catch {
        // 文件不存在或读取失败，返回 null（由 builder 决定是否为致命错误）
        return null
      }
    }
  }
}

/**
 * 基于内存 Map 的 PromptLoader（用于测试）。
 * key = 相对路径，value = 文件内容。
 */
export function createMemoryPromptLoader(files: Record<string, string>): PromptLoader {
  return {
    load(relativePath: string): string | null {
      return relativePath in files ? files[relativePath] : null
    }
  }
}
