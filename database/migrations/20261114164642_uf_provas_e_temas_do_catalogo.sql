begin;

alter table public.concursos add column uf text
  check (uf in ('AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG',
                'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'));

-- Reaproveita a UF quando o órgão segue o padrão legado de sigla após a barra.
update public.concursos
set uf = upper(substring(btrim(orgao) from '/([A-Za-z]{2})$'))
where upper(substring(btrim(orgao) from '/([A-Za-z]{2})$')) in
  ('AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG',
   'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO');

create or replace view public.provas with (security_invoker = true) as
select p."idConcurso" as "idProva", p.ano, p.orgao, p."idOrganizadora",
  b.nome as organizadora, nullif(btrim(p.cargo),'') as cargo,
  p.composicao_confirmada,
  (p."idOrganizadora" is null or length(btrim(p.orgao)) not between 1 and 200
    or exists(select 1 from public.questoes q where q."idConcurso" = p."idConcurso"
      and (q."idTema" is null or q.numero is null))) as revisao_pendente, p.uf
from public.concursos p left join public.bancas b on b."idBanca" = p."idOrganizadora";

create function provas_privado.salvar_prova(
  p_idprova uuid, p_ano integer, p_orgao text, p_idorganizadora uuid, p_cargo text,
  p_composicao_confirmada boolean, p_uf text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  -- A operação original valida a sessão administrativa e os dados da prova.
  v_id := provas_privado.salvar_prova(
    p_idprova, p_ano, p_orgao, p_idorganizadora, p_cargo, p_composicao_confirmada
  );
  update public.concursos set uf = nullif(upper(btrim(p_uf)), '') where "idConcurso" = v_id;
  return v_id;
end;
$$;

create function public.salvar_prova(
  p_idprova uuid, p_ano integer, p_orgao text, p_idorganizadora uuid, p_cargo text,
  p_composicao_confirmada boolean, p_uf text
) returns uuid
language sql security invoker set search_path = '' as $$
  select provas_privado.salvar_prova(
    p_idprova, p_ano, p_orgao, p_idorganizadora, p_cargo, p_composicao_confirmada, p_uf
  );
$$;

revoke all on function provas_privado.salvar_prova(uuid, integer, text, uuid, text, boolean, text)
  from public, anon;
revoke all on function public.salvar_prova(uuid, integer, text, uuid, text, boolean, text)
  from public, anon;
grant execute on function provas_privado.salvar_prova(uuid, integer, text, uuid, text, boolean, text)
  to authenticated;
grant execute on function public.salvar_prova(uuid, integer, text, uuid, text, boolean, text)
  to authenticated;

insert into public.temas(nome) values
  ('Administração Pública'),
  ('Atualidades'),
  ('Ciências da Natureza'),
  ('Ética e Filosofia'),
  ('Fundamentos de Odontologia'),
  ('Geografia'),
  ('História'),
  ('Informática'),
  ('Legislação Policial Militar'),
  ('Língua Portuguesa'),
  ('Matemática'),
  ('Raciocínio Lógico-Matemático')
on conflict do nothing;

commit;
