<script setup lang="ts">
defineProps<{
  kicker: string
  title: string
  description: string
}>()
</script>

<template>
  <section class="settings-section-frame">
    <header class="section-heading">
      <p class="section-kicker">{{ kicker }}</p>
      <h2>{{ title }}</h2>
      <p class="section-description">{{ description }}</p>
    </header>
    <slot />
  </section>
</template>

<style scoped>
.settings-section-frame {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.section-heading {
  max-width: 660px;
}

.section-kicker {
  margin-bottom: 9px;
  color: var(--color-accent);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.19em;
}

.section-heading h2 {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: clamp(25px, 3.2vw, 36px);
  font-weight: 560;
  letter-spacing: -0.025em;
  line-height: 1.12;
}

.section-description {
  max-width: 60ch;
  margin-top: 10px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.72;
}
</style>
