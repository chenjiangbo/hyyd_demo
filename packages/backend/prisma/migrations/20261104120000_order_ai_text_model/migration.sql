DO $$
BEGIN
  IF to_regclass('public.sys_settings') IS NOT NULL THEN
    UPDATE sys_settings
    SET value = jsonb_set(value, '{textAnalysisModel}', '"qwen-plus"'::jsonb, true)
    WHERE key = 'order_ai_automation_config' AND NOT value ? 'textAnalysisModel';
    UPDATE sys_settings
    SET value = jsonb_set(value, '{textAnalysisProvider}', '"dashscope"'::jsonb, true)
    WHERE key = 'order_ai_automation_config' AND NOT value ? 'textAnalysisProvider';
    UPDATE sys_settings
    SET value = jsonb_set(value, '{imageAnalysisModel}', '"qwen3-vl-plus"'::jsonb, true)
    WHERE key = 'order_ai_automation_config' AND NOT value ? 'imageAnalysisModel';
  END IF;
END $$;
