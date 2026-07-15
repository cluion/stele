/**
 * WYSIWYG 的 markdown 快捷輸入:打 markdown 記號自動轉為對應區塊
 * 規則組合沿用 prosemirror-example-setup 的標準寫法
 */
import { inputRules, textblockTypeInputRule, wrappingInputRule, type InputRule } from "prosemirror-inputrules";
import type { Plugin } from "prosemirror-state";
import { steleSchema } from "./schema.ts";

const nodes = steleSchema.nodes;

const rules: InputRule[] = [
  // ``` → code block
  textblockTypeInputRule(/^```$/, nodes["code_block"]!),
  // #×n + 空格 → 標題
  textblockTypeInputRule(/^(#{1,6})\s$/, nodes["heading"]!, (match) => ({ level: match[1]!.length })),
  // - / + / * + 空格 → 無序清單
  wrappingInputRule(/^\s*([-+*])\s$/, nodes["bullet_list"]!),
  // 1. + 空格 → 有序清單
  wrappingInputRule(
    /^(\d+)\.\s$/,
    nodes["ordered_list"]!,
    (match) => ({ order: Number(match[1]) }),
    (match, node) => node.childCount + Number(node.attrs["order"]) === Number(match[1]),
  ),
  // > + 空格 → 引用
  wrappingInputRule(/^\s*>\s$/, nodes["blockquote"]!),
];

export const markdownInputRules: Plugin = inputRules({ rules });
