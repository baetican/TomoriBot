export default {
  memory: {
    description: `保存された記憶とドキュメントを管理します。`,
    document: {
      description: `ドキュメント記憶を管理します。`,
      add: {
        description: `ドキュメントを記憶に追加します。`,
      },
      remove: {
        description: `ドキュメントを記憶から削除します。`,
      },
    },
    personal: {
      description: `個人記憶を管理します。`,
      add: {
        description: `個人記憶を追加します。`,
      },
      remove: {
        description: `個人記憶を削除します。`,
      },
      "admin-edit": {
        description: `[ボットオーナー] 他のユーザーの個人記憶を編集します。`,
        member_description: `個人記憶を編集する対象のユーザー。`,
        scope_description: `ペルソナ記憶かグローバル記憶かを選択します。`,
        scope_choice_persona: `ペルソナ`,
        scope_choice_global: `グローバル`,
        target_is_bot_title: `ボットは対象にできません`,
        target_is_bot_description: `ボットには個人記憶がありません。`,
        target_not_found_title: `ユーザーが見つかりません`,
        target_not_found_description: `{user_mention} はまだ私と対話していないため、保存されたデータがありません。`,
        no_memories_title: `個人記憶がありません`,
        no_memories_description: `{user_mention} はこのスコープに個人記憶を保存していません。`,
        select_modal_title: `個人記憶を選択`,
        select_label: `編集する記憶`,
        select_description: `編集する個人記憶を選択してください`,
        select_placeholder: `記憶を選択...`,
        confirm_title: `個人記憶を編集しますか？`,
        confirm_description: `{user_mention} のこの個人記憶を選択しました:
> {memory}

**確認** を押すと編集モーダルを開きます。`,
        modal_title: `個人記憶を編集`,
        memory_input_label: `更新後の個人記憶`,
        memory_input_description: `選択した個人記憶を新しいテキストに置き換えます。`,
        memory_input_placeholder: `{user}はマンゴーが好き`,
        no_changes_title: `変更はありません`,
        no_changes_description: `その個人記憶は既にその内容に設定されています。`,
        duplicate_title: `重複した個人記憶`,
        duplicate_description: `この記憶 '{memory}' は既にこのユーザーの個人記憶にあります。`,
        success_title: `個人記憶を更新しました`,
        success_description: `{user_mention} の個人記憶を正常に更新しました: "{memory}"`,
      },
      "admin-remove": {
        description: `[ボットオーナー] 他のユーザーの個人記憶を削除します。`,
        member_description: `個人記憶を削除する対象のユーザー。`,
        scope_description: `ペルソナ記憶かグローバル記憶かを選択します。`,
        scope_choice_persona: `ペルソナ`,
        scope_choice_global: `グローバル`,
        target_is_bot_title: `ボットは対象にできません`,
        target_is_bot_description: `ボットには個人記憶がありません。`,
        target_not_found_title: `ユーザーが見つかりません`,
        target_not_found_description: `{user_mention} はまだ私と対話していないため、保存されたデータがありません。`,
        no_memories_title: `個人記憶がありません`,
        no_memories_description: `{user_mention} はこのスコープに個人記憶を保存していません。`,
        modal_title: `個人記憶の削除`,
        select_label: `削除する記憶`,
        select_description: `削除する個人記憶を選択してください`,
        select_placeholder: `記憶を選択...`,
        success_title: `個人記憶を削除しました`,
        success_description: `{user_mention} の個人記憶を正常に削除しました: "{memory}"`,
      },
    },
    server: {
      description: `サーバー記憶を管理します。`,
      add: {
        description: `サーバー記憶を追加します。`,
      },
      remove: {
        description: `サーバー記憶を削除します。`,
      },
    },
  },
};
