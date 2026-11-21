-- Gerada localmente. Aplicação remota depende de revisão/autorização separada.
-- Reverter não deve restaurar SELECT amplo: corrigir a allowlist em nova migration.
begin;
revoke select on table public.questoes from authenticated;
-- Remove também qualquer grant anterior da coluna sensível, sem alterar RLS.
revoke select (explicacao) on public.questoes from authenticated;
grant select ("idQuestao", "idConcurso", "idBanca", "idDisciplina", "idAssunto",
  "idTema", numero, enunciado, tipo, dificuldade, ano, fonte, imagem_url, status,
  "idPessoaCriadora", criada_em, atualizada_em) on public.questoes to authenticated;
commit;
