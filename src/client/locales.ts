import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'composer-enhancer': 'historyTitle' | 'historySearch' | 'historyResults' | 'historyClose' |
      'optimize' | 'optimizePending' | 'optimizeUndo' | 'optimizeError' | 'optimizeChips' | 'optimizeChipSelection' |
      'optimizeModelUnavailable' | 'optimizeRequestFailed' | 'optimizeInvalidOutput' | 'optimizeRollbackFailed' | 'optimizeSessionChanged' |
      'settingsTitle' | 'settingsSubtitle' | 'history' | 'historyDescription' | 'optimizeDescription' |
      'predict' | 'predictDescription' | 'privacyTitle' | 'privacy' | 'coexistence' | 'settingsError' |
      'overlapHistory' | 'overlapOptimize' | 'overlapPredict' | 'dismissHint'
  }
}

export const composerLocales = {
  zh: {
    historyTitle: '历史提示词',
    historySearch: '搜索历史提示词',
    historyResults: '历史提示词结果',
    historyClose: '关闭历史提示词',
    optimize: '优化提示词',
    optimizePending: '正在优化提示词',
    optimizeUndo: '撤销优化',
    optimizeError: '优化失败，请重试',
    optimizeModelUnavailable: '当前模型不可用，请检查模型选择',
    optimizeRequestFailed: '优化请求失败，请重试',
    optimizeInvalidOutput: '模型返回内容无法安全应用，请重试',
    optimizeRollbackFailed: '草稿恢复失败，请检查草稿并手动恢复',
    optimizeSessionChanged: '会话已变化，请重新优化',
    optimizeChips: '保留引用，仅优化其他文字',
    optimizeChipSelection: '选区包含引用，请优化整稿或调整选区',
    settingsTitle: 'Composer 增强',
    settingsSubtitle: '按需开启输入辅助功能',
    history: '历史提示词',
    historyDescription: '↑↓ 回顾已发送提示词；Alt+R 搜索（可用环境兼容 Ctrl+R）',
    optimizeDescription: '优化草稿或所选内容，支持一键撤销',
    predict: '下一条提示词预测',
    predictDescription: '回复后给出一条建议，按 Tab 采纳',
    privacyTitle: '数据与隐私',
    privacy: '优化和预测会把所选内容或近期对话发送给当前模型提供商；历史不请求模型；不采集提示词内容或采纳率遥测。',
    coexistence: '检测到官方或第三方同类能力时仅提示，不会自动停用。',
    settingsError: '设置未保存，请重试。',
    overlapHistory: '检测到另一个历史提示词功能。Composer 增强的历史功能仍保持开启。',
    overlapOptimize: '检测到另一个提示词优化功能。Composer 增强的优化功能仍保持开启。',
    overlapPredict: '检测到另一个回复建议功能。Composer 增强的预测功能仍保持开启。',
    dismissHint: '关闭共存提示',
  },
  en: {
    historyTitle: 'Prompt history',
    historySearch: 'Search prompt history',
    historyResults: 'Prompt history results',
    historyClose: 'Close prompt history',
    optimize: 'Optimize prompt',
    optimizePending: 'Optimizing prompt',
    optimizeUndo: 'Undo optimization',
    optimizeError: 'Optimization failed. Try again.',
    optimizeModelUnavailable: 'Model unavailable. Check the model selection.',
    optimizeRequestFailed: 'Optimization failed. Try again.',
    optimizeInvalidOutput: 'The model response cannot be applied safely. Try again.',
    optimizeRollbackFailed: 'Draft recovery failed. Check the draft and restore it manually.',
    optimizeSessionChanged: 'Session changed. Optimize again.',
    optimizeChips: 'References stay unchanged; only surrounding text is optimized',
    optimizeChipSelection: 'Selection includes references. Optimize the full draft or adjust the selection.',
    settingsTitle: 'Composer Enhance',
    settingsSubtitle: 'Toggle input helpers as needed',
    history: 'Prompt history',
    historyDescription: '↑↓ revisit sent prompts; Alt+R to search (Ctrl+R in compatible environments)',
    optimizeDescription: 'Optimize the draft or selection, with one-click undo',
    predict: 'Next-prompt prediction',
    predictDescription: 'One suggestion after a reply; Tab to accept',
    privacyTitle: 'Data and privacy',
    privacy: 'Optimization and prediction send selected text or recent conversation to the current model provider. History never requests a model. No prompt content or acceptance-rate telemetry is collected.',
    coexistence: 'Similar official or third-party features are only reported; they are never disabled automatically.',
    settingsError: 'Setting was not saved. Try again.',
    overlapHistory: 'Another prompt-history feature is enabled. Composer Enhance history remains enabled.',
    overlapOptimize: 'Another prompt-optimization feature is enabled. Composer Enhance optimization remains enabled.',
    overlapPredict: 'Another reply-suggestion feature is enabled. Composer Enhance prediction remains enabled.',
    dismissHint: 'Dismiss coexistence notice',
  },
} as const
