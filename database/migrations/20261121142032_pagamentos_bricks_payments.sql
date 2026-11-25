begin;
-- Additive migration. Existing Orders identifiers, receipts and periods remain untouched.
alter table public.pedidos_pagamento
 add column provedor text not null default 'orders' check(provedor in ('orders','payments')),
 add column id_pagamento_mp text unique check(id_pagamento_mp ~ '^[0-9]{1,30}$'),
 add column status_pagamento_mp text,
 add column detalhe_pagamento_mp text,
 add column estado_checkout_mp text not null default 'novo' check(estado_checkout_mp in ('novo','enviando','ambiguo','concluido'));
alter table public.pagamentos alter column id_order_mp drop not null;
alter table financeiro.webhooks
 add column provedor text not null default 'orders' check(provedor in ('orders','payments')),
 add column ambiente text not null default 'teste' check(ambiente in ('teste','producao'));
update financeiro.webhooks w set ambiente=p.ambiente from public.pedidos_pagamento p where w.recurso=p.id_order_mp;

create or replace function financeiro.json_pedido(p public.pedidos_pagamento) returns jsonb
language sql immutable set search_path='' as $$
 select (to_jsonb(p)-'checkout_payload'-'reserva'-'reserva_ate'-'estado_checkout_mp'-'id_pagamento_mp'-'status_pagamento_mp'-'detalhe_pagamento_mp') ||
 jsonb_build_object('valor',p.valor::text,'idPagamentoMp',p.id_pagamento_mp,'statusPagamentoMp',p.status_pagamento_mp,'status_detail',p.detalhe_pagamento_mp)
$$;
create function financeiro.operar_backend_legacy(p_operacao text,p_dados jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 v_pessoa uuid; v_admin uuid; v_pedido public.pedidos_pagamento; v_plano public.planos_comerciais;
 v_ass public.assinaturas; v_pag public.pagamentos; v_json jsonb; v_inicio timestamptz; v_fim timestamptz;
 v_status text; v_reserva uuid; v_versao timestamptz; v_count integer; v_row record; v_dias integer;
begin
 v_pessoa:=nullif(p_dados->>'pessoa','')::uuid;
 v_admin:=nullif(p_dados->>'administrador','')::uuid;
 if v_admin is not null and not exists(select 1 from public.usuarios where "idUsuario"=v_admin and tipo='administrador' and estado_cadastro='ativo') then
  raise exception 'Administrador indisponível' using errcode='42501';
 end if;
 case p_operacao
 when 'limitar_requisicao' then
  insert into financeiro.limites_requisicoes(chave,minuto,quantidade) values(p_dados->>'chave',date_trunc('minute',now()),1)
   on conflict(chave,minuto) do update set quantidade=limites_requisicoes.quantidade+1 returning quantidade into v_count;
  if v_count>least((p_dados->>'limite')::integer,30) then raise exception 'Muitas solicitações financeiras. Aguarde um minuto.' using errcode='P0429'; end if;
  return 'true'::jsonb;
 when 'criar_pedido' then
  if p_dados->>'ambiente'<>(select ambiente from financeiro.configuracao) then raise exception 'Ambiente financeiro do banco e da API não correspondem'; end if;
  if not exists(select 1 from public.usuarios where "idUsuario"=v_pessoa and tipo='estudante' and estado_cadastro='ativo' and cadastro_completo) then raise exception 'Cadastro de estudante incompleto' using errcode='42501'; end if;
  -- Lock the existing identity row to serialize all checkouts and renewals for one student.
  perform 1 from public.pessoas where "idPessoa"=v_pessoa for update;
  select * into v_pedido from public.pedidos_pagamento where chave_idempotencia=(p_dados->>'chave')::uuid;
  if found then
   if v_pedido.id_pessoa<>v_pessoa or v_pedido.id_plano<>(p_dados->>'plano')::uuid or v_pedido.ambiente<>p_dados->>'ambiente' then raise exception 'Chave de idempotência já utilizada'; end if;
   return financeiro.json_pedido(v_pedido);
  end if;
  select * into v_pedido from public.pedidos_pagamento where id_pessoa=v_pessoa and id_plano=(p_dados->>'plano')::uuid and ambiente=p_dados->>'ambiente' and status in ('pendente','processando');
  if found then return financeiro.json_pedido(v_pedido); end if;
  select * into v_plano from public.planos_comerciais where id=(p_dados->>'plano')::uuid and ativo for share;
  if not found then raise exception 'Plano indisponível'; end if;
  insert into public.pedidos_pagamento(id_pessoa,id_plano,plano_nome,duracao_meses,beneficios,valor,moeda,ambiente,chave_idempotencia,referencia_externa)
  values(v_pessoa,v_plano.id,v_plano.nome,v_plano.duracao_meses,v_plano.beneficios,v_plano.valor,v_plano.moeda,p_dados->>'ambiente',(p_dados->>'chave')::uuid,gen_random_uuid()::text) returning * into v_pedido;
  insert into public.assinaturas(id_pessoa,id_pedido,id_plano,plano_nome,valor,duracao_meses,beneficios) values(v_pessoa,v_pedido.id,v_plano.id,v_plano.nome,v_plano.valor,v_plano.duracao_meses,v_plano.beneficios) returning * into v_ass;
  insert into public.historico_assinaturas(id_pessoa,id_assinatura,tipo,chave) values(v_pessoa,v_ass.id,'assinatura_criada',v_pedido.id::text||':criada');
  return financeiro.json_pedido(v_pedido);
 when 'pedido' then
  select * into v_pedido from public.pedidos_pagamento where id=(p_dados->>'id')::uuid;
  if not found then raise exception 'Pedido não encontrado'; end if;
  return financeiro.json_pedido(v_pedido);
 when 'pedido_order' then
  select * into v_pedido from public.pedidos_pagamento where id_order_mp=p_dados->>'order';
  if not found then return null; end if;
  return financeiro.json_pedido(v_pedido);
 when 'reservar_checkout' then
  v_reserva:=gen_random_uuid();
  update public.pedidos_pagamento set reserva=v_reserva,reserva_ate=now()+interval '45 seconds',
   checkout_payload=coalesce(checkout_payload,p_dados->'payload')
   where id=(p_dados->>'id')::uuid and id_order_mp is null and (reserva_ate is null or reserva_ate<now()) returning * into v_pedido;
  if not found then return null; end if;
  return jsonb_build_object('reserva',v_reserva,'payload',v_pedido.checkout_payload);
 when 'salvar_checkout' then
  update public.pedidos_pagamento set id_order_mp=p_dados->>'order',checkout_url=p_dados->>'url',reserva=null,reserva_ate=null,atualizado_em=now()
   where id=(p_dados->>'id')::uuid and reserva=(p_dados->>'reserva')::uuid and (id_order_mp is null or id_order_mp=p_dados->>'order') returning * into v_pedido;
  if not found then raise exception 'Reserva do checkout indisponível'; end if;
  return financeiro.json_pedido(v_pedido);
 when 'liberar_checkout' then
  update public.pedidos_pagamento set reserva=null,reserva_ate=null where id=(p_dados->>'id')::uuid and reserva=(p_dados->>'reserva')::uuid;
  return 'true'::jsonb;
 when 'receber_webhook' then
  insert into financeiro.webhooks(chave,recurso,provedor,ambiente) values(p_dados->>'chave',p_dados->>'order',coalesce(p_dados->>'provedor','orders'),coalesce(p_dados->>'ambiente',(select ambiente from financeiro.configuracao))) on conflict do nothing;
  return 'true'::jsonb;
 when 'reservar_eventos' then
  update financeiro.webhooks set status='falha',erro='reserva_expirada_limite_tentativas',reserva=null,reserva_ate=null where status='processando' and tentativas>=12 and reserva_ate<now();
  with fila as (
   select chave from financeiro.webhooks where tentativas<12 and proxima_tentativa_em<=now()
   and (status='pendente' or (status='processando' and reserva_ate<now())) order by proxima_tentativa_em for update skip locked limit least(coalesce((p_dados->>'limite')::integer,10),50)
  ), reservados as (update financeiro.webhooks w set status='processando',tentativas=tentativas+1,reserva=gen_random_uuid(),reserva_ate=now()+interval '90 seconds' from fila where w.chave=fila.chave returning w.*) select coalesce(jsonb_agg(to_jsonb(reservados)),'[]'::jsonb) into v_json from reservados;
  return v_json;
 when 'concluir_evento' then
  update financeiro.webhooks set status=case when p_dados->>'erro' is null then 'processado' when tentativas>=12 then 'falha' else 'pendente' end,
   processado_em=case when p_dados->>'erro' is null then now() end, erro=p_dados->>'erro',reserva=null,reserva_ate=null,
   proxima_tentativa_em=now()+make_interval(secs=>least(3600,30*power(2,least(tentativas,7))::integer))
   where chave=p_dados->>'chave' and reserva=(p_dados->>'reserva')::uuid;
  return 'true'::jsonb;
 when 'aplicar_order' then
  select id_pessoa into v_pessoa from public.pedidos_pagamento where id=(p_dados->>'id')::uuid;
  perform 1 from public.pessoas where "idPessoa"=v_pessoa for update;
  select * into strict v_pedido from public.pedidos_pagamento where id=(p_dados->>'id')::uuid for update;
  v_status:=p_dados->>'status'; v_versao:=(p_dados->>'versao')::timestamptz;
  if v_pedido.id_order_mp<>p_dados->>'order' or v_pedido.valor<>(p_dados->>'valor')::numeric or v_pedido.moeda<>p_dados->>'moeda' then raise exception 'Order divergente'; end if;
  if v_pedido.ultima_versao_mp>v_versao then return financeiro.json_pedido(v_pedido); end if;
  if v_pedido.ultima_versao_mp=v_versao and v_pedido.status<>v_status then raise exception 'Conflito de versão financeira'; end if;
  -- Terminal reversals are never undone by a delayed approved notification.
  if v_pedido.status in ('estornado','contestado') and v_status not in ('estornado','contestado') then return financeiro.json_pedido(v_pedido); end if;
  update public.pedidos_pagamento set status=v_status,ultima_versao_mp=v_versao,consultado_em=now(),atualizado_em=now(),
   webhook_confirmado=webhook_confirmado or coalesce((p_dados->>'webhook')::boolean,false) where id=v_pedido.id returning * into v_pedido;
  insert into public.pagamentos(id_pedido,id_pessoa,id_plano,id_order_mp,id_pagamento_mp,referencia_pagamento_mp,valor,moeda,status,metodo,parcelas,valor_estornado,detalhe_status,aprovado_em)
   values(v_pedido.id,v_pessoa,v_pedido.id_plano,v_pedido.id_order_mp,p_dados->>'pagamento',p_dados->>'referencia_pagamento',v_pedido.valor,v_pedido.moeda,v_status,p_dados->>'metodo',(p_dados->>'parcelas')::integer,coalesce((p_dados->>'estornado')::numeric,0),p_dados->>'detalhe',case when v_status='aprovado' then now() end)
   on conflict(id_pedido) do update set status=excluded.status,id_pagamento_mp=coalesce(excluded.id_pagamento_mp,pagamentos.id_pagamento_mp),referencia_pagamento_mp=coalesce(excluded.referencia_pagamento_mp,pagamentos.referencia_pagamento_mp),metodo=excluded.metodo,parcelas=excluded.parcelas,valor_estornado=excluded.valor_estornado,detalhe_status=excluded.detalhe_status,aprovado_em=coalesce(pagamentos.aprovado_em,excluded.aprovado_em),atualizado_em=now() returning * into v_pag;
  select * into strict v_ass from public.assinaturas where id_pedido=v_pedido.id for update;
  update public.assinaturas set id_pagamento=v_pag.id where id=v_ass.id;
  if v_status='aprovado' and v_ass.inicio_em is null and v_pedido.webhook_confirmado then
   select greatest(now(),coalesce(max(fim_em),now())) into v_inicio from public.assinaturas where id_pessoa=v_pessoa and status='ativa';
   v_fim:=((v_inicio at time zone 'UTC')+make_interval(months=>v_pedido.duracao_meses)) at time zone 'UTC';
   update public.assinaturas set status='ativa',inicio_em=v_inicio,fim_em=v_fim,atualizado_em=now() where id=v_ass.id;
   insert into public.historico_assinaturas(id_pessoa,id_assinatura,tipo,dados,chave)
    values(v_pessoa,v_ass.id,case when v_inicio>now() then 'renovacao' else 'ativacao' end,jsonb_build_object('inicio',v_inicio,'fim',v_fim,'pagamento',v_pag.id),v_pedido.id::text||':ativada') on conflict do nothing;
  elsif v_status in ('estornado','contestado','cancelado','rejeitado') then
   update public.assinaturas set status=case when v_status='contestado' then 'suspensa' else 'cancelada' end,
    cancelamento_em=case when v_status<>'contestado' then coalesce(cancelamento_em,now()) end,atualizado_em=now() where id=v_ass.id;
  end if;
  insert into public.historico_assinaturas(id_pessoa,id_assinatura,tipo,dados,chave)
   values(v_pessoa,v_ass.id,'pagamento_'||v_status,jsonb_build_object('detalhe',p_dados->>'detalhe','order',v_pedido.id_order_mp),v_pedido.id::text||':'||v_status||':'||v_versao::text) on conflict do nothing;
  return financeiro.json_pedido(v_pedido);
 when 'conciliar' then
  return coalesce((select jsonb_agg(financeiro.json_pedido(p)) from (
   select * from public.pedidos_pagamento where (id_order_mp is not null or checkout_payload is not null) and criado_em>now()-interval '400 days'
    and (consultado_em is null or consultado_em<now()-interval '15 minutes')
    order by consultado_em nulls first,criado_em limit least(coalesce((p_dados->>'limite')::integer,10),50)
  ) p),'[]'::jsonb);
 when 'limitar_sincronizacao' then
  update public.pedidos_pagamento set consultado_em=now() where id=(p_dados->>'id')::uuid and (consultado_em is null or consultado_em<now()-interval '10 seconds');
  if not found then raise exception 'Aguarde alguns segundos antes de consultar novamente' using errcode='P0429'; end if;
  return 'true'::jsonb;
 when 'solicitar_cancelamento' then
  select * into strict v_ass from public.assinaturas where id=(p_dados->>'id')::uuid and id_pessoa=v_pessoa;
  insert into public.historico_assinaturas(id_pessoa,id_assinatura,tipo,dados,chave)
   values(v_pessoa,v_ass.id,'cancelamento_solicitado',jsonb_build_object('justificativa',p_dados->>'justificativa'),v_ass.id::text||':cancelamento_solicitado') on conflict do nothing;
  return jsonb_build_object('recebido',true,'mensagem','Solicitação registrada para análise pelo suporte. Seu período pago permanece disponível até a análise; não há cobrança automática.');
 when 'painel' then
  if v_admin is null then raise exception 'Administrador obrigatório' using errcode='42501'; end if;
  return jsonb_build_object(
   'ambiente',(select ambiente from financeiro.configuracao),
   'planos',(select coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('valor',p.valor::text) order by p.ordem),'[]') from public.planos_comerciais p),
   'pagamentos',(select coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('valor',p.valor::text,'valor_estornado',p.valor_estornado::text,'email',u.email)),'[]') from (
    select * from public.pagamentos p where (v_pessoa is null or p.id_pessoa=v_pessoa)
     and (nullif(p_dados->>'plano','') is null or p.id_plano=(p_dados->>'plano')::uuid)
     and (nullif(p_dados->>'status','') is null or p.status=p_dados->>'status')
     and (nullif(p_dados->>'de','') is null or p.criado_em>=(p_dados->>'de')::timestamptz)
     and (nullif(p_dados->>'ate','') is null or p.criado_em<(p_dados->>'ate')::timestamptz+interval '1 day')
     order by p.criado_em desc limit 30 offset (coalesce((p_dados->>'pagina')::integer,1)-1)*30
   ) p join public.usuarios u on u."idUsuario"=p.id_pessoa),
   'assinaturas',(select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('valor',a.valor::text,'email',u.email)),'[]') from (
    select * from public.assinaturas a where (v_pessoa is null or a.id_pessoa=v_pessoa)
     and (nullif(p_dados->>'plano','') is null or a.id_plano=(p_dados->>'plano')::uuid)
     and (nullif(p_dados->>'status','') is null or a.status=p_dados->>'status')
     and (nullif(p_dados->>'vencimento','') is null or a.fim_em<(p_dados->>'vencimento')::timestamptz+interval '1 day')
     order by a.criado_em desc limit 30 offset (coalesce((p_dados->>'pagina')::integer,1)-1)*30
   ) a join public.usuarios u on u."idUsuario"=a.id_pessoa),
   'historico',(select coalesce(jsonb_agg(to_jsonb(h)),'[]') from (select * from public.historico_assinaturas where v_pessoa is null or id_pessoa=v_pessoa order by criado_em desc limit 50) h),
   'eventosFalhos',(select coalesce(jsonb_agg(to_jsonb(w)-'reserva'),'[]') from (select * from financeiro.webhooks where status='falha' order by recebido_em desc limit 30) w),
   'cancelamentos',(select coalesce(jsonb_agg(to_jsonb(h)),'[]') from (select * from public.historico_assinaturas where tipo='cancelamento_solicitado' order by criado_em desc limit 30) h),
   'indicadores',(select jsonb_build_object(
    'bruto',coalesce(sum(valor) filter(where aprovado_em is not null),0)::text,
    'estornos',coalesce(sum(valor_estornado),0)::text,
    'contestado',coalesce(sum(valor) filter(where status='contestado'),0)::text,
    'liquidoEstimado',coalesce(sum(case when status='contestado' then 0 else valor-valor_estornado end) filter(where aprovado_em is not null),0)::text,
    'pendentes',count(*) filter(where status in ('pendente','processando')),
    'aprovados',count(*) filter(where status='aprovado'),'rejeitados',count(*) filter(where status='rejeitado'))
    from public.pagamentos where (nullif(p_dados->>'de','') is null or criado_em>=(p_dados->>'de')::timestamptz) and (nullif(p_dados->>'ate','') is null or criado_em<(p_dados->>'ate')::timestamptz+interval '1 day')),
   'ativos',(select count(distinct id_pessoa) from public.assinaturas where status='ativa' and inicio_em<=now() and fim_em>now()),
   'porPlano',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from (select plano_nome,count(*) quantidade from public.assinaturas where status='ativa' and inicio_em<=now() and fim_em>now() group by plano_nome) r),
   'vencendo',(select count(distinct id_pessoa) from public.assinaturas where status='ativa' and fim_em between now() and now()+interval '7 days' and not exists(select 1 from public.assinaturas b where b.id_pessoa=assinaturas.id_pessoa and b.status='ativa' and b.fim_em>assinaturas.fim_em)),
   'renovacoes',(select count(*) from public.historico_assinaturas where tipo='renovacao'),
   'pagina',coalesce((p_dados->>'pagina')::integer,1)
  );
 when 'marcar_consulta' then
  update public.pedidos_pagamento set consultado_em=now() where id=(p_dados->>'id')::uuid;
  return 'true'::jsonb;
 when 'manutencao' then
  update financeiro.webhooks set status='falha',erro='reserva_expirada_limite_tentativas',reserva=null,reserva_ate=null where status='processando' and tentativas>=12 and reserva_ate<now();
  delete from financeiro.limites_requisicoes where minuto<now()-interval '2 days';
  with expiradas as (update public.assinaturas set status='expirada',atualizado_em=now() where status='ativa' and fim_em<=now() returning *)
  insert into public.historico_assinaturas(id_pessoa,id_assinatura,tipo,chave) select id_pessoa,id,'expiracao',id::text||':expirada' from expiradas on conflict do nothing;
  for v_row in select a.* from public.assinaturas a where a.status in ('ativa','expirada') and a.fim_em between now()-interval '1 day' and now()+interval '8 days'
   and not exists(select 1 from public.assinaturas outra where outra.id_pessoa=a.id_pessoa and outra.status='ativa' and outra.fim_em>a.fim_em) loop
   v_dias:=greatest(0,ceil(extract(epoch from v_row.fim_em-now())/86400)::integer);
   if v_dias in (0,1,3,7) then
    insert into public.avisos_assinatura(id_pessoa,id_assinatura,dias,fim_em,mensagem)
    values(v_row.id_pessoa,v_row.id,v_dias,v_row.fim_em,case when v_dias=0 then 'Seu Premium venceu. Escolha um plano para renovar.' else 'Seu Premium vence em '||v_dias||' dia(s). A renovação é manual.' end) on conflict do nothing;
    get diagnostics v_count=row_count;
    if v_count=1 then
     insert into comunicacao.emails_transacionais("idEmailTransacional",tipo_evento,"idUsuario",email_destinatario,assunto,dados_template,maximo_tentativas,agendado_em,chave_idempotencia)
     select gen_random_uuid(),'SUBSCRIPTION_EXPIRING',u."idUsuario",u.email,'Sua assinatura Siso Aprova',jsonb_build_object('nome',u.email),5,now(),'assinatura:'||v_row.id||':'||v_dias||':'||v_row.fim_em::text
     from public.usuarios u where u."idUsuario"=v_row.id_pessoa on conflict(chave_idempotencia) do nothing;
    end if;
   end if;
  end loop;
  return 'true'::jsonb;
 when 'salvar_plano' then
  if v_admin is null then raise exception 'Administrador obrigatório' using errcode='42501'; end if;
  if nullif(p_dados->>'id','') is not null then select * into strict v_plano from public.planos_comerciais where id=(p_dados->>'id')::uuid for update; end if;
  insert into public.planos_comerciais(id,codigo,nome,descricao,valor,duracao_meses,beneficios,ordem,ativo,destaque)
   values(coalesce(v_plano.id,gen_random_uuid()),coalesce(v_plano.codigo,p_dados->>'codigo'),p_dados->>'nome',p_dados->>'descricao',(p_dados->>'valor')::numeric,(p_dados->>'duracao_meses')::integer,p_dados->'beneficios',(p_dados->>'ordem')::integer,(p_dados->>'ativo')::boolean,(p_dados->>'destaque')::boolean)
   on conflict(id) do update set nome=excluded.nome,descricao=excluded.descricao,valor=excluded.valor,duracao_meses=excluded.duracao_meses,beneficios=excluded.beneficios,ordem=excluded.ordem,ativo=excluded.ativo,destaque=excluded.destaque,atualizado_em=now() returning to_jsonb(planos_comerciais)||jsonb_build_object('valor',planos_comerciais.valor::text) into v_json;
  insert into financeiro.auditoria(id_administrador,acao,recurso,dados) values(v_admin,'salvar_plano',v_json->>'id',jsonb_build_object('antes',to_jsonb(v_plano),'depois',v_json));
  return v_json;
 when 'auditar' then
  insert into financeiro.auditoria(id_administrador,acao,recurso,dados) values(v_admin,p_dados->>'acao',p_dados->>'id',jsonb_build_object('justificativa',p_dados->>'justificativa','chave',p_dados->>'chave'));
  return 'true'::jsonb;
 when 'reprocessar_eventos' then
  if v_admin is null then raise exception 'Administrador obrigatório' using errcode='42501'; end if;
  update financeiro.webhooks set status='pendente',tentativas=0,proxima_tentativa_em=now() where status='falha';
  insert into financeiro.auditoria(id_administrador,acao,recurso) values(v_admin,'reprocessar_webhooks','fila');
  return 'true'::jsonb;
 when 'operacao_financeira' then
  if v_admin is null then raise exception 'Administrador obrigatório' using errcode='42501'; end if;
  select * into strict v_pedido from public.pedidos_pagamento where id=(p_dados->>'id')::uuid for update;
  if p_dados->>'acao'='estornar' and v_pedido.status<>'aprovado' then raise exception 'Somente pagamentos aprovados podem ser estornados'; end if;
  if p_dados->>'acao'='cancelar' and v_pedido.status not in ('pendente','processando') then raise exception 'Somente pedidos pendentes podem ser cancelados'; end if;
  insert into financeiro.auditoria(id_administrador,acao,recurso,dados) values(v_admin,p_dados->>'acao',v_pedido.id::text,jsonb_build_object('justificativa',p_dados->>'justificativa','chave',p_dados->>'chave'));
  return financeiro.json_pedido(v_pedido);
 else raise exception 'Operação financeira inválida';
 end case;
end $$;

create or replace function financeiro.operar_backend(p_operacao text,p_dados jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.pedidos_pagamento; pl public.planos_comerciais; pe uuid; ad uuid; r uuid; v jsonb; amb text;
begin
 pe:=nullif(p_dados->>'pessoa','')::uuid; ad:=nullif(p_dados->>'administrador','')::uuid;
 if ad is not null and not exists(select 1 from public.usuarios where "idUsuario"=ad and tipo='administrador' and estado_cadastro='ativo') then raise exception 'Administrador indisponível' using errcode='42501'; end if;
 case p_operacao
 when 'criar_pedido_payments' then
  if p_dados->>'ambiente' is distinct from (select ambiente from financeiro.configuracao) then raise exception 'Ambiente divergente'; end if;
  if not exists(select 1 from public.usuarios where "idUsuario"=pe and tipo='estudante' and estado_cadastro='ativo' and cadastro_completo) then raise exception 'Cadastro incompleto' using errcode='42501'; end if;
  perform 1 from public.pessoas where "idPessoa"=pe for update;
  select * into p from public.pedidos_pagamento where chave_idempotencia=(p_dados->>'chave')::uuid;
  if found then
   if p.id_pessoa<>pe or p.id_plano<>(p_dados->>'plano')::uuid or p.ambiente<>p_dados->>'ambiente' then raise exception 'Chave já utilizada' using errcode='23505'; end if;
   return financeiro.json_pedido(p);
  end if;
  if exists(select 1 from public.pedidos_pagamento where id_pessoa=pe and ambiente=p_dados->>'ambiente' and estado_checkout_mp in ('enviando','ambiguo')) then raise exception 'Conciliação pendente' using errcode='40001'; end if;
  select * into p from public.pedidos_pagamento where id_pessoa=pe and id_plano=(p_dados->>'plano')::uuid and ambiente=p_dados->>'ambiente' and status in ('pendente','processando');
  if found then return financeiro.json_pedido(p); end if;
  select * into pl from public.planos_comerciais where id=(p_dados->>'plano')::uuid and ativo for share;
  if not found then raise exception 'Plano indisponível'; end if;
  insert into public.pedidos_pagamento(id_pessoa,id_plano,plano_nome,duracao_meses,beneficios,valor,moeda,ambiente,chave_idempotencia,referencia_externa,provedor)
   values(pe,pl.id,pl.nome,pl.duracao_meses,pl.beneficios,pl.valor,pl.moeda,p_dados->>'ambiente',(p_dados->>'chave')::uuid,gen_random_uuid()::text,'payments') returning * into p;
  insert into public.assinaturas(id_pessoa,id_pedido,id_plano,plano_nome,valor,duracao_meses,beneficios) values(pe,p.id,pl.id,pl.nome,pl.valor,pl.duracao_meses,pl.beneficios);
  insert into public.historico_assinaturas(id_pessoa,id_assinatura,tipo,chave) select pe,a.id,'assinatura_criada',p.id::text||':criada' from public.assinaturas a where a.id_pedido=p.id;
  return financeiro.json_pedido(p);
 when 'reservar_payment' then
  r:=gen_random_uuid();
  update public.pedidos_pagamento set estado_checkout_mp='enviando',reserva=r,reserva_ate=now()+interval '90 seconds',atualizado_em=now()
   where id=(p_dados->>'id')::uuid and provedor='payments' and estado_checkout_mp='novo' and id_pagamento_mp is null returning * into p;
  if not found then return null; end if;
  return jsonb_build_object('reserva',r);
 when 'falhar_payment' then
  update public.pedidos_pagamento set estado_checkout_mp='concluido',status='rejeitado',status_pagamento_mp='rejected',detalhe_pagamento_mp='creation_rejected',reserva=null,reserva_ate=null,atualizado_em=now()
   where id=(p_dados->>'id')::uuid and reserva=(p_dados->>'reserva')::uuid and id_pagamento_mp is null;
  update public.assinaturas set status='cancelada',cancelamento_em=coalesce(cancelamento_em,now()),atualizado_em=now()
   where id_pedido=(p_dados->>'id')::uuid and status='pendente';
  return 'true'::jsonb;
 when 'ambiguo_payment' then
  update public.pedidos_pagamento set estado_checkout_mp='ambiguo',reserva=null,reserva_ate=null,atualizado_em=now()
   where id=(p_dados->>'id')::uuid and reserva=(p_dados->>'reserva')::uuid and id_pagamento_mp is null;
  return 'true'::jsonb;
 when 'vincular_payment' then
  if p_dados->>'pagamento' !~ '^[0-9]{1,30}$' then raise exception 'Pagamento inválido'; end if;
  update public.pedidos_pagamento set id_pagamento_mp=p_dados->>'pagamento',estado_checkout_mp='concluido',reserva=null,reserva_ate=null,atualizado_em=now()
   where id=(p_dados->>'id')::uuid and provedor='payments' and (id_pagamento_mp is null or id_pagamento_mp=p_dados->>'pagamento') returning * into p;
  if not found then raise exception 'Pagamento divergente'; end if;
  return financeiro.json_pedido(p);
 when 'pedido_payment' then
  select * into p from public.pedidos_pagamento where provedor='payments' and id_pagamento_mp=p_dados->>'pagamento';
  if not found then return null; end if; return financeiro.json_pedido(p);
 when 'pedido_referencia' then
  select * into p from public.pedidos_pagamento where provedor='payments' and referencia_externa=p_dados->>'referencia';
  if not found then return null; end if; return financeiro.json_pedido(p);
 when 'aplicar_payment' then
  select * into p from public.pedidos_pagamento where id=(p_dados->>'id')::uuid;
  perform 1 from public.pessoas where "idPessoa"=p.id_pessoa for update;
  select * into strict p from public.pedidos_pagamento where id=(p_dados->>'id')::uuid for update;
  if p.provedor<>'payments' or p.id_pagamento_mp is distinct from p_dados->>'pagamento' then raise exception 'Pagamento divergente'; end if;
  if p.ultima_versao_mp>(p_dados->>'versao')::timestamptz then return financeiro.json_pedido(p); end if;
  if p.status in ('estornado','contestado') and p_dados->>'status' not in ('estornado','contestado') then return financeiro.json_pedido(p); end if;
  update public.pedidos_pagamento set status_pagamento_mp=p_dados->>'status_mp',detalhe_pagamento_mp=p_dados->>'detalhe' where id=p.id;
  v:=financeiro.operar_backend_legacy('aplicar_order',p_dados||jsonb_build_object('order',null));
  update public.pedidos_pagamento set consultado_em=p.consultado_em where id=p.id;
  return v;
 when 'aplicar_order' then
  if exists(select 1 from public.pedidos_pagamento where id=(p_dados->>'id')::uuid and provedor<>'orders') then raise exception 'Provedor divergente'; end if;
  return financeiro.operar_backend_legacy(p_operacao,p_dados);
 when 'conciliar' then
  return coalesce((select jsonb_agg(financeiro.json_pedido(q)) from (
   select * from public.pedidos_pagamento where criado_em>now()-interval '400 days'
    and (id_order_mp is not null or checkout_payload is not null or (provedor='payments' and (id_pagamento_mp is not null or estado_checkout_mp in ('enviando','ambiguo'))))
    and (consultado_em is null or consultado_em<now()-interval '15 minutes')
    order by consultado_em nulls first,criado_em limit least(coalesce((p_dados->>'limite')::integer,3),50)
  ) q),'[]'::jsonb);
 when 'painel' then
  if ad is null then raise exception 'Administrador obrigatório' using errcode='42501'; end if;
  amb:=coalesce(nullif(p_dados->>'ambiente',''),(select ambiente from financeiro.configuracao));
  if amb not in ('teste','producao') then raise exception 'Ambiente inválido'; end if;
  with filtrados as (
   select q.* from public.pedidos_pagamento q left join public.assinaturas a on a.id_pedido=q.id
   where q.ambiente=amb and (pe is null or q.id_pessoa=pe)
    and (nullif(p_dados->>'plano','') is null or q.id_plano=(p_dados->>'plano')::uuid)
    and (nullif(p_dados->>'status','') is null or q.status=p_dados->>'status')
    and (nullif(p_dados->>'de','') is null or q.criado_em>=(p_dados->>'de')::date)
    and (nullif(p_dados->>'ate','') is null or q.criado_em<(p_dados->>'ate')::date+interval '1 day')
    and (nullif(p_dados->>'vencimento','') is null or a.fim_em<(p_dados->>'vencimento')::date+interval '1 day')
  ), pag as (select x.* from public.pagamentos x join filtrados f on f.id=x.id_pedido),
  ass as (select a.* from public.assinaturas a join filtrados f on f.id=a.id_pedido),
  hist as (select h.* from public.historico_assinaturas h join ass a on a.id=h.id_assinatura)
  select jsonb_build_object(
   'ambiente',amb,'pagina',coalesce((p_dados->>'pagina')::integer,1),
   'planos',(select coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('valor',x.valor::text) order by x.ordem),'[]'::jsonb) from public.planos_comerciais x),
   'pagamentos',(select coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('valor',x.valor::text,'valor_estornado',x.valor_estornado::text,'email',u.email)),'[]'::jsonb) from (select * from pag order by criado_em desc limit 30 offset (coalesce((p_dados->>'pagina')::integer,1)-1)*30) x join public.usuarios u on u."idUsuario"=x.id_pessoa),
   'assinaturas',(select coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('valor',x.valor::text,'email',u.email)),'[]'::jsonb) from (select * from ass order by criado_em desc limit 30 offset (coalesce((p_dados->>'pagina')::integer,1)-1)*30) x join public.usuarios u on u."idUsuario"=x.id_pessoa),
   'historico',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (select * from hist order by criado_em desc limit 50) x),
   'cancelamentos',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (select * from hist where tipo='cancelamento_solicitado' order by criado_em desc limit 30) x),
   'eventosFalhos',(select coalesce(jsonb_agg(to_jsonb(x)-'reserva'),'[]'::jsonb) from (select w.* from financeiro.webhooks w where w.ambiente=amb and w.status='falha' and ((pe is null and nullif(p_dados->>'plano','') is null and nullif(p_dados->>'status','') is null and nullif(p_dados->>'de','') is null and nullif(p_dados->>'ate','') is null and nullif(p_dados->>'vencimento','') is null) or exists(select 1 from filtrados f where (f.provedor=w.provedor and w.recurso=coalesce(f.id_pagamento_mp,f.id_order_mp)))) order by recebido_em desc limit 30) x),
   'aprovadosSemWebhook',(select coalesce(jsonb_agg(financeiro.json_pedido(x)),'[]'::jsonb) from (select * from filtrados where status='aprovado' and not webhook_confirmado order by criado_em desc limit 30) x),
   'checkoutsInconclusivos',(select coalesce(jsonb_agg(financeiro.json_pedido(x)),'[]'::jsonb) from (select * from filtrados where estado_checkout_mp in ('enviando','ambiguo') order by criado_em desc limit 30) x),
   'indicadores',(select jsonb_build_object('bruto',coalesce(sum(valor) filter(where aprovado_em is not null),0)::text,'estornos',coalesce(sum(valor_estornado),0)::text,'contestado',coalesce(sum(valor) filter(where status='contestado'),0)::text,'liquidoEstimado',coalesce(sum(case when status='contestado' then 0 else valor-valor_estornado end) filter(where aprovado_em is not null),0)::text,'pendentes',count(*) filter(where status in ('pendente','processando')),'aprovados',count(*) filter(where status='aprovado'),'rejeitados',count(*) filter(where status='rejeitado')) from pag),
   'ativos',(select count(distinct id_pessoa) from ass where status='ativa' and inicio_em<=now() and fim_em>now()),
   'porPlano',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (select plano_nome,count(*) quantidade from ass where status='ativa' and inicio_em<=now() and fim_em>now() group by plano_nome) x),
   'vencendo',(select count(distinct a.id_pessoa) from ass a where a.status='ativa' and a.fim_em between now() and now()+interval '7 days' and not exists(select 1 from ass b where b.id_pessoa=a.id_pessoa and b.status='ativa' and b.fim_em>a.fim_em)),
   'renovacoes',(select count(*) from hist where tipo='renovacao')
  ) into v; return v;
 else return financeiro.operar_backend_legacy(p_operacao,p_dados);
 end case;
end $$;
revoke all on function financeiro.operar_backend_legacy(text,jsonb),financeiro.operar_backend(text,jsonb) from public,anon,authenticated,concursa_dados;
grant execute on function financeiro.operar_backend(text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
