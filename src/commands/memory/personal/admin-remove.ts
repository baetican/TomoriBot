import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags } from "discord.js";
import type { UserRow, ErrorContext, TomoriState } from "@/types/db/schema";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { isBotOwner } from "@/utils/discord/ownerCheck";
import { promptWithPaginatedModal, safeSelectOptionText } from "@/utils/discord/ui/modals";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import {
  buildPersonaWorkflowNotice,
  completePersonaWorkflow,
  retryPersonaWorkflow,
  runPersonaPickerWorkflow,
  type PersonaWorkflowMessageController,
} from "@/utils/discord/ui/personaWorkflow";
import { lineageIdIsEligible, refreshEligibilitySet } from "@/utils/discord/ui/personaEligibility";
import { personaRepository, personalMemoryRepository, userRepository } from "@/utils/db/repositories";
import { invalidateUserCache } from "@/utils/cache/userCache";
import type { SelectOption } from "@/types/discord/modal";

const MODAL_CUSTOM_ID = "memory_personal_admin_remove_modal";
const MEMORY_SELECT_ID = "memory_select";
const PERSONAL_SCOPE_VALUE = "persona";
const GLOBAL_SCOPE_VALUE = "global";
const GLOBAL_PERSONAL_MEMORY_LINEAGE_ID = 0;

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("admin-remove")
    .setDescription(localizer("en-US", "commands.memory.personal.admin-remove.description"))
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription(localizer("en-US", "commands.memory.personal.admin-remove.member_description"))
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("scope")
        .setDescription(localizer("en-US", "commands.memory.personal.admin-remove.scope_description"))
        .setRequired(false)
        .addChoices(
          {
            name: localizer("en-US", "commands.memory.personal.admin-remove.scope_choice_persona"),
            value: PERSONAL_SCOPE_VALUE,
          },
          {
            name: localizer("en-US", "commands.memory.personal.admin-remove.scope_choice_global"),
            value: GLOBAL_SCOPE_VALUE,
          },
        ),
    );

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.channel_only_title",
      descriptionKey: "general.errors.channel_only_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isBotOwner(interaction.user.id)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.not_bot_owner_title",
      descriptionKey: "general.errors.not_bot_owner_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const targetDiscordUser = interaction.options.getUser("member", true);

  if (targetDiscordUser.bot) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.memory.personal.admin-remove.target_is_bot_title",
      descriptionKey: "commands.memory.personal.admin-remove.target_is_bot_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const targetUserData = await userRepository.loadByDiscordId(targetDiscordUser.id);
  if (!targetUserData?.user_id) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.memory.personal.admin-remove.target_not_found_title",
      descriptionKey: "commands.memory.personal.admin-remove.target_not_found_description",
      descriptionVars: { user_mention: `<@${targetDiscordUser.id}>` },
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const targetUserId = targetUserData.user_id;
  const userMention = `<@${targetUserData.user_disc_id}>`;

  let tomoriState: TomoriState | null = null;
  const workflowState: { message: PersonaWorkflowMessageController | null; selectedPersonaId?: number } = {
    message: null,
  };
  const memoryScope =
    (interaction.options.getString("scope") as typeof PERSONAL_SCOPE_VALUE | typeof GLOBAL_SCOPE_VALUE | null) ??
    PERSONAL_SCOPE_VALUE;

  try {
    if (memoryScope === PERSONAL_SCOPE_VALUE) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    tomoriState = await personaRepository.loadState(interaction.guild?.id ?? interaction.user.id);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const serverDiscId = interaction.guild?.id ?? interaction.user.id;
    if (memoryScope === PERSONAL_SCOPE_VALUE) {
      const allPersonas = await personaRepository.loadAllForServer(serverDiscId);
      if (allPersonas.length === 0) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "general.errors.tomori_not_setup_title",
          descriptionKey: "general.errors.tomori_not_setup_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const eligibleLineageIds = await personalMemoryRepository.lineageIdsWithMemories(targetUserId);
      const isEligible = lineageIdIsEligible(eligibleLineageIds);
      const eligiblePersonas = allPersonas.filter(isEligible);
      if (eligiblePersonas.length === 0) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "commands.memory.personal.admin-remove.no_memories_title",
          descriptionKey: "commands.memory.personal.admin-remove.no_memories_description",
          descriptionVars: { user_mention: userMention },
          color: ColorCode.WARN,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const workflowResult = await runPersonaPickerWorkflow(interaction, locale, {
        personas: allPersonas,
        color: ColorCode.INFO,
        eligibility: {
          isEligible,
          emptyTitleKey: "commands.memory.personal.admin-remove.no_memories_title",
          emptyDescriptionKey: "commands.memory.personal.admin-remove.no_memories_description",
          itemsLabelKey: "general.persona_workflow.items.personal_memories",
        },
        async onSelected(selection) {
          workflowState.message = selection.message;
          workflowState.selectedPersonaId = selection.persona.persona_id ?? undefined;
          const targetLineageId = selection.persona.persona_lineage_id ?? GLOBAL_PERSONAL_MEMORY_LINEAGE_ID;
          if (targetLineageId === GLOBAL_PERSONAL_MEMORY_LINEAGE_ID) {
            const work = await selection.beginInPlaceWork();
            await work.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "general.errors.operation_failed_title",
                descriptionKey: "general.errors.operation_failed_description",
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.ERROR,
              }),
            );
            return retryPersonaWorkflow();
          }

          let currentMemories: Awaited<ReturnType<typeof personalMemoryRepository.loadForUserLineage>> = [];
          let hasNoMemories = false;
          const modalResult = await selection.openModal(async () => {
            const fetchedMemories = await personalMemoryRepository.loadForUserLineage(
              targetUserId,
              targetLineageId,
              false,
            );
            currentMemories = fetchedMemories.filter((memory) => memory.persona_lineage_id === targetLineageId);
            if (currentMemories.length === 0) {
              hasNoMemories = true;
              throw new Error("The selected persona has no personal memories.");
            }
            const memorySelectOptions: SelectOption[] = currentMemories.map((memory, index) => ({
              label: safeSelectOptionText(memory.content, 20),
              value: index.toString(),
              description: safeSelectOptionText(memory.content),
            }));
            return {
              modalCustomId: MODAL_CUSTOM_ID,
              modalTitleKey: "commands.memory.personal.admin-remove.modal_title",
              components: [
                {
                  customId: MEMORY_SELECT_ID,
                  labelKey: "commands.memory.personal.admin-remove.select_label",
                  descriptionKey: "commands.memory.personal.admin-remove.select_description",
                  placeholder: "commands.memory.personal.admin-remove.select_placeholder",
                  required: true,
                  options: memorySelectOptions,
                },
              ],
            };
          });

          if (hasNoMemories) {
            await selection.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "commands.memory.personal.admin-remove.no_memories_title",
                descriptionKey: "commands.memory.personal.admin-remove.no_memories_description",
                descriptionVars: { user_mention: userMention },
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.WARN,
              }),
            );
            return retryPersonaWorkflow(await personaRepository.loadAllForServer(serverDiscId));
          }
          if (modalResult.outcome !== "submitted") {
            log.info(`Personal memory admin-remove modal ${modalResult.outcome} for owner ${userData.user_id}`);
            return modalResult.outcome === "fatal" ? completePersonaWorkflow() : retryPersonaWorkflow();
          }

          const work = await modalResult.phase.beginInPlaceWork();
          const selectedIndex = Number.parseInt(modalResult.phase.values[MEMORY_SELECT_ID] ?? "", 10);
          const selectedMemory = currentMemories[selectedIndex];
          if (!selectedMemory?.personal_memory_id) {
            await work.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "general.errors.operation_failed_title",
                descriptionKey: "commands.memory.personal.admin-remove.no_memories_description",
                descriptionVars: { user_mention: userMention },
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.ERROR,
              }),
            );
            return retryPersonaWorkflow();
          }

          const ok = await personalMemoryRepository.remove(selectedMemory.personal_memory_id);
          if (!ok) {
            await work.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "general.errors.update_failed_title",
                descriptionKey: "general.errors.update_failed_description",
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.ERROR,
              }),
            );
            return retryPersonaWorkflow();
          }

          invalidateUserCache(targetUserData.user_disc_id);
          log.success(
            `Bot owner ${interaction.user.id} deleted personal memory "${selectedMemory.content.slice(0, 30)}..." for user ${targetUserData.user_disc_id} (ID: ${targetUserId})`,
          );
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.memory.personal.admin-remove.success_title",
              descriptionKey: "commands.memory.personal.admin-remove.success_description",
              descriptionVars: {
                memory:
                  selectedMemory.content.length > 50
                    ? `${selectedMemory.content.slice(0, 50)}...`
                    : selectedMemory.content,
                user_mention: userMention,
              },
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.SUCCESS,
            }),
          );
          // Refresh eligibility in place so a lineage whose last personal memory
          // was removed drops from the picker on retry (reaching mid-loop empty).
          await refreshEligibilitySet(
            eligibleLineageIds,
            personalMemoryRepository.lineageIdsWithMemories(targetUserId),
          );
          return retryPersonaWorkflow(await personaRepository.loadAllForServer(serverDiscId));
        },
      });
      if (workflowResult.outcome === "error" && workflowState.message) {
        await workflowState.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "general.errors.unknown_error_title",
            descriptionKey: "general.errors.unknown_error_description",
            color: ColorCode.ERROR,
          }),
        );
      }
      return;
    }

    // GLOBAL scope: load lineage-0 memories directly (no persona picker needed)
    const globalMemories = await personalMemoryRepository.loadForUserLineage(
      targetUserId,
      GLOBAL_PERSONAL_MEMORY_LINEAGE_ID,
      false,
    );

    if (globalMemories.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.memory.personal.admin-remove.no_memories_title",
        descriptionKey: "commands.memory.personal.admin-remove.no_memories_description",
        descriptionVars: { user_mention: userMention },
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const memorySelectOptions: SelectOption[] = globalMemories.map((memory, index) => ({
      label: safeSelectOptionText(memory.content, 20),
      value: index.toString(),
      description: safeSelectOptionText(memory.content),
    }));

    const modalResult = await promptWithPaginatedModal(interaction, locale, {
      modalCustomId: MODAL_CUSTOM_ID,
      modalTitleKey: "commands.memory.personal.admin-remove.modal_title",
      components: [
        {
          customId: MEMORY_SELECT_ID,
          labelKey: "commands.memory.personal.admin-remove.select_label",
          descriptionKey: "commands.memory.personal.admin-remove.select_description",
          placeholder: "commands.memory.personal.admin-remove.select_placeholder",
          required: true,
          options: memorySelectOptions,
        },
      ],
    });

    if (modalResult.outcome !== "submit") {
      log.info(`Global personal memory admin-remove modal ${modalResult.outcome} for owner ${userData.user_id}`);
      return;
    }

    const modalSubmitInteraction = modalResult.interaction;
    const selectedIndex = modalResult.values?.[MEMORY_SELECT_ID];

    if (!modalSubmitInteraction || !selectedIndex) {
      log.error("Modal result unexpectedly missing interaction or values");
      return;
    }

    const selectedMemory = globalMemories[Number.parseInt(selectedIndex, 10)];
    if (!selectedMemory?.personal_memory_id) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "general.errors.operation_failed_title",
        descriptionKey: "commands.memory.personal.admin-remove.no_memories_description",
        descriptionVars: { user_mention: userMention },
        color: ColorCode.ERROR,
      });
      return;
    }

    const ok = await personalMemoryRepository.remove(selectedMemory.personal_memory_id);
    if (!ok) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    invalidateUserCache(targetUserData.user_disc_id);
    log.success(
      `Bot owner ${interaction.user.id} deleted personal memory "${selectedMemory.content.slice(0, 30)}..." for user ${targetUserData.user_disc_id} (ID: ${targetUserId})`,
    );
    await replyInfoEmbed(modalSubmitInteraction, locale, {
      titleKey: "commands.memory.personal.admin-remove.success_title",
      descriptionKey: "commands.memory.personal.admin-remove.success_description",
      descriptionVars: {
        memory:
          selectedMemory.content.length > 50 ? `${selectedMemory.content.slice(0, 50)}...` : selectedMemory.content,
        user_mention: userMention,
      },
      color: ColorCode.SUCCESS,
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState?.server_id,
      personaId: workflowState.selectedPersonaId ?? tomoriState?.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "memory personal admin-remove",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
        targetDiscordUserId: targetDiscordUser.id,
      },
    };
    await log.error(
      `Unexpected error in /memory personal admin-remove for owner ${interaction.user.id} targeting ${targetDiscordUser.id}`,
      error as Error,
      context,
    );

    if (workflowState.message) {
      await workflowState.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        }),
      );
      return;
    }
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
