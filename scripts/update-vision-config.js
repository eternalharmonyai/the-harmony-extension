const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const props = pkg.contributes.configuration.properties;

// 1. Update vision.provider enum
props['harmony.vision.provider'].enum = ['auto', 'gemini', 'zhipu', 'alibaba'];
props['harmony.vision.provider'].description = 'Vision provider. auto=configurable fallback order. Single-provider modes skip fallback.';

// 2. Add zhipuModel
if (!props['harmony.vision.zhipuModel']) {
  props['harmony.vision.zhipuModel'] = {
    type: 'string', enum: ['glm-5v-turbo', 'glm-5v'], default: 'glm-5v-turbo',
    description: 'Zhipu GLM vision model for image analysis.'
  };
}

// 3. Add fallbackOrder
props['harmony.vision.fallbackOrder'] = {
  type: 'array', items: { type: 'string', enum: ['gemini', 'zhipu', 'alibaba'] },
  default: ['gemini', 'zhipu', 'alibaba'],
  description: 'Fallback order for vision auto mode. Reorder in sidebar or settings.json.'
};

fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

// Verify
const v = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const p = v.contributes.configuration.properties;
console.log('enum:', p['harmony.vision.provider'].enum.join(','));
console.log('fallbackOrder:', !!p['harmony.vision.fallbackOrder']);
console.log('OK');
