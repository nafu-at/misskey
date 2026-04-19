<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<SearchMarker path="/settings/avatar-decoration" :label="i18n.ts.avatarDecorations" :keywords="['avatar', 'icon', 'decoration']" icon="ti ti-sparkles">
	<div>
		<div v-if="!loading" class="_gaps">
			<MkInfo>{{ i18n.tsx._profile.avatarDecorationMax({ max: $i.policies.avatarDecorationLimit }) }} ({{ i18n.tsx.remainingN({ n: $i.policies.avatarDecorationLimit - $i.avatarDecorations.length }) }})</MkInfo>

			<MkAvatar :class="$style.avatar" :user="$i" forceShowDecoration/>

			<div v-if="matchedDecorations.length > 0" v-panel :class="$style.current" class="_gaps_s">
				<div>{{ i18n.ts.inUse }}</div>

				<Sortable
					v-model="matchedDecorations"
					tag="div"
					:class="$style.decorations"
					itemKey="itemKey"
					:animation="150"
					:handle="'.' + $style.dragHandle"
					@change="() => void saveCurrentDecorationOrder()"
					@start="e => e.item.classList.add('active')"
					@end="e => e.item.classList.remove('active')"
				>
					<template #item="{ element, index }">
						<div :class="$style.decorationItem">
							<button class="_button" :class="$style.dragHandle" :title="i18n.ts.rearrange" tabindex="-1">
								<i class="ti ti-grip-vertical"></i>
							</button>
							<XDecoration
								:decoration="element"
								:angle="element.angle"
								:flipH="element.flipH"
								:offsetX="element.offsetX"
								:offsetY="element.offsetY"
								:active="true"
								@click="openDecoration(element, index)"
							/>
						</div>
					</template>
				</Sortable>

				<MkButton danger @click="detachAllDecorations">{{ i18n.ts.detachAll }}</MkButton>
			</div>

			<div :class="$style.decorations">
				<XDecoration
					v-for="avatarDecoration in avatarDecorations"
					:key="avatarDecoration.id"
					:decoration="avatarDecoration"
					@click="openDecoration(avatarDecoration)"
				/>
			</div>
		</div>
		<div v-else>
			<MkLoading/>
		</div>
	</div>
</SearchMarker>
</template>

<script lang="ts" setup>
import { computed, defineAsyncComponent, ref } from 'vue';
import * as Misskey from 'misskey-js';
import XDecoration from './avatar-decoration.decoration.vue';
import MkButton from '@/components/MkButton.vue';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { ensureSignin } from '@/i.js';
import MkInfo from '@/components/MkInfo.vue';
import { definePage } from '@/page.js';

const Sortable = defineAsyncComponent(() => import('vuedraggable').then(x => x.default));

const $i = ensureSignin();

const loading = ref(true);
const avatarDecorations = ref<Misskey.entities.GetAvatarDecorationsResponse>([]);
const matchedDecorations = ref<Array<Misskey.entities.GetAvatarDecorationsResponse[number] & Misskey.entities.UserDetailed['avatarDecorations'][number] & {
	itemKey: string;
}>>([]);

const decorationMap = computed(() => new Map(avatarDecorations.value.map(decoration => [decoration.id, decoration])));

misskeyApi('get-avatar-decorations').then(_avatarDecorations => {
	avatarDecorations.value = _avatarDecorations;
	syncMatchedDecorations();
	loading.value = false;
});

function syncMatchedDecorations() {
	if (loading.value && avatarDecorations.value.length === 0) return;

	matchedDecorations.value = $i.avatarDecorations.map(userDecoration => {
		const decoration = decorationMap.value.get(userDecoration.id);
		const url = userDecoration.url.length > 0 ? userDecoration.url : (decoration?.url ?? '');
		return {
			...userDecoration,
			...decoration,
			url,
			itemKey: Math.random().toString(36).slice(2),
		};
	}).filter(d => d.url); // URLが存在するもののみ
}

function normalizeDecoration(decoration) {
	return {
		id: decoration.id,
		angle: decoration.angle ?? 0,
		flipH: decoration.flipH ?? false,
		url: decoration.url ?? '',
		offsetX: decoration.offsetX ?? 0,
		offsetY: decoration.offsetY ?? 0,
	};
}

async function updateAvatarDecorations(update) {
	const normalized = update.map(normalizeDecoration);
	try {
		await os.apiWithDialog('i/update', {
			avatarDecorations: normalized,
		});
		$i.avatarDecorations = normalized;
	} finally {
		syncMatchedDecorations();
	}
}

async function saveCurrentDecorationOrder() {
	await updateAvatarDecorations(matchedDecorations.value);
}

function openDecoration(avatarDecoration, index?: number) {
	os.popup(defineAsyncComponent(() => import('./avatar-decoration.dialog.vue')), {
		decoration: avatarDecoration,
		usingIndex: index ?? null,
	}, {
		'attach': async (payload) => {
			const decoration = {
				id: avatarDecoration.id,
				angle: payload.angle,
				flipH: payload.flipH,
				url: avatarDecoration.url ?? avatarDecorations.value.find(d => d.id === avatarDecoration.id)?.url ?? '',
				offsetX: payload.offsetX,
				offsetY: payload.offsetY,
			};
			const update = [...$i.avatarDecorations, decoration];
			await updateAvatarDecorations(update);
		},
		'update': async (payload) => {
			const decoration = {
				id: avatarDecoration.id,
				angle: payload.angle,
				flipH: payload.flipH,
				url: avatarDecoration.url ?? avatarDecorations.value.find(d => d.id === avatarDecoration.id)?.url ?? '',
				offsetX: payload.offsetX,
				offsetY: payload.offsetY,
			};
			const update = [...$i.avatarDecorations];
			if (index == null) return;

			update[index] = decoration;
			await updateAvatarDecorations(update);
		},
		'detach': async () => {
			const update = [...$i.avatarDecorations];
			if (index == null) return;

			update.splice(index, 1);
			await updateAvatarDecorations(update);
		},
	}, 'closed');
}

function detachAllDecorations() {
	os.confirm({
		type: 'warning',
		text: i18n.ts.areYouSure,
	}).then(async ({ canceled }) => {
		if (canceled) return;
		await updateAvatarDecorations([]);
	});
}

const headerActions = computed(() => []);

const headerTabs = computed(() => []);

definePage(() => ({
	title: i18n.ts.avatarDecorations,
	icon: 'ti ti-sparkles',
}));
</script>

<style lang="scss" module>
.avatar {
	display: inline-block;
	width: 72px;
	height: 72px;
	margin: 16px auto;
}

.current {
	padding: 16px;
	border-radius: var(--MI-radius);
}

.decorations {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
	grid-gap: 12px;
}

.decorationItem {
	position: relative;
}

.dragHandle {
	position: absolute;
	top: 8px;
	right: 8px;
	z-index: 1;
	width: 28px;
	height: 28px;
	border-radius: 999px;
	cursor: move;
	color: var(--MI_THEME-fgTransparentWeak);
	background: var(--MI_THEME-bg);
}
</style>
