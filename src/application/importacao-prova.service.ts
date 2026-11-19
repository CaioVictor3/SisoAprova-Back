import { normalizarUf } from "../domain/validacao-uf.js";
import { randomUUID } from "node:crypto";
import { ServicoAutorizacaoUsuarioAutenticado } from "./autorizacao-usuario-autenticado.js";
import {
  criarRespostaSucesso,
  ErroRegraNegocioHttp,
} from "../domain/erros-validacoes-respostas-api.js";
import type { RepositorioConsultasNegocio } from "../infrastructure/repositorio-consultas-postgresql.js";

function objeto(valor: unknown, campo: string) {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) {
    throw new ErroRegraNegocioHttp(`Informe um objeto para ${campo}.`);
  }
  return valor as Record<string, unknown>;
}

function texto(valor: unknown, campo: string, limite: number, vazio = false) {
  if (
    typeof valor !== "string" ||
    valor.includes("\u0000") ||
    valor.length > limite ||
    (!vazio && !valor.trim())
  ) {
    throw new ErroRegraNegocioHttp(`Confira ${campo} (até ${limite} caracteres).`);
  }
  return valor.trim();
}

function uuid(valor: unknown, campo: string) {
  if (
    typeof valor !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(valor) ||
    valor === "00000000-0000-0000-0000-000000000000"
  ) {
    throw new ErroRegraNegocioHttp(`Informe um identificador válido para ${campo}.`);
  }
  return valor.toLowerCase();
}

function inteiro(valor: unknown, campo: string, minimo: number, maximo: number) {
  if (typeof valor !== "number" || !Number.isInteger(valor) || valor < minimo || valor > maximo) {
    throw new ErroRegraNegocioHttp(`Confira ${campo}.`);
  }
  return valor;
}

export function prepararImportacaoProva(entrada: unknown) {
  const requisicao = objeto(entrada, "a importação");
  const arquivo = objeto(requisicao.arquivo, "o arquivo");
  if (typeof requisicao.aplicar !== "boolean") {
    throw new ErroRegraNegocioHttp("Escolha validar ou importar.");
  }
  if (
    !Array.isArray(arquivo.questoes) ||
    arquivo.questoes.length < 1 ||
    arquivo.questoes.length > 250
  ) {
    throw new ErroRegraNegocioHttp("Informe entre 1 e 250 questões por arquivo.");
  }

  const idProva = arquivo.idProva == null ? null : uuid(arquivo.idProva, "a prova");
  if (idProva && arquivo.prova != null) {
    throw new ErroRegraNegocioHttp("Informe apenas idProva ou os dados de uma prova nova.");
  }
  const dados = idProva ? null : objeto(arquivo.prova, "a prova");
  const prova = dados && {
    ano: inteiro(dados.ano, "o ano da prova", 1000, 9999),
    uf: normalizarUf(dados.uf),
    orgao: texto(dados.orgao, "o órgão", 200),
    cargo: texto(dados.cargo ?? "", "o cargo", 200, true),
    idOrganizadora:
      dados.idOrganizadora == null ? null : uuid(dados.idOrganizadora, "a organizadora"),
    organizadora:
      dados.idOrganizadora == null
        ? texto(dados.organizadora, "o nome da organizadora", 200)
        : null,
  };

  const numeros = new Set<number>();
  const questoes = arquivo.questoes.map((entradaQuestao, indice) => {
    const questao = objeto(entradaQuestao, `a questão na posição ${indice + 1}`);
    const numero = inteiro(
      questao.numero,
      `o número da questão na posição ${indice + 1}`,
      1,
      2147483647,
    );
    const campo = `da questão ${numero}`;
    if (numeros.has(numero)) throw new ErroRegraNegocioHttp(`O número ${numero} está repetido.`);
    numeros.add(numero);
    if (questao.idQuestao != null) {
      throw new ErroRegraNegocioHttp(
        `Remova idQuestao ${campo}. A importação insere questões novas.`,
      );
    }
    if (
      !Array.isArray(questao.alternativas) ||
      questao.alternativas.length < 2 ||
      questao.alternativas.length > 10
    ) {
      throw new ErroRegraNegocioHttp(`Informe entre 2 e 10 alternativas para a questão ${numero}.`);
    }
    const letras = new Set<string>();
    const textos = new Set<string>();
    const alternativas = questao.alternativas.map((entradaAlternativa, indiceAlternativa) => {
      const alternativa = objeto(
        entradaAlternativa,
        `a alternativa ${indiceAlternativa + 1} ${campo}`,
      );
      const letra = texto(alternativa.letra, `a letra ${campo}`, 1).toUpperCase();
      const conteudo = texto(alternativa.texto, `o texto da alternativa ${letra} ${campo}`, 8000);
      const normalizado = conteudo.toLocaleLowerCase("pt-BR");
      if (!/^[A-J]$/.test(letra) || letras.has(letra) || textos.has(normalizado)) {
        throw new ErroRegraNegocioHttp(
          `Confira as letras e os textos das alternativas da questão ${numero}.`,
        );
      }
      letras.add(letra);
      textos.add(normalizado);
      return { idAlternativa: randomUUID(), letra, texto: conteudo, ordem: indiceAlternativa + 1 };
    });
    const statusGabarito = questao.statusGabarito ?? "pendente";
    if (
      !["pendente", "anulada", "provisorio", "definitivo"].some(
        (status) => status === statusGabarito,
      )
    ) {
      throw new ErroRegraNegocioHttp(`Confira a situação do gabarito ${campo}.`);
    }
    const exigeResposta = statusGabarito === "provisorio" || statusGabarito === "definitivo";
    const letraCorreta =
      questao.letraCorreta == null
        ? null
        : texto(questao.letraCorreta, `a letra correta ${campo}`, 1).toUpperCase();
    const idAlternativaCorreta =
      alternativas.find(({ letra }) => letra === letraCorreta)?.idAlternativa ?? null;
    if (
      (exigeResposta && !idAlternativaCorreta) ||
      (!exigeResposta && letraCorreta !== null) ||
      questao.idAlternativaCorreta != null
    ) {
      throw new ErroRegraNegocioHttp(
        `Confira a letra correta e a situação do gabarito ${campo}. Use letraCorreta para apontar a resposta.`,
      );
    }
    const dificuldade = questao.dificuldade ?? "nao_informada";
    if (!["facil", "media", "dificil", "nao_informada"].some((nivel) => nivel === dificuldade)) {
      throw new ErroRegraNegocioHttp(`Confira a dificuldade ${campo}.`);
    }
    const imagem_url =
      questao.imagemUrl == null ? null : texto(questao.imagemUrl, `a URL da imagem ${campo}`, 2048);
    if (imagem_url && !URL.canParse(imagem_url)) {
      throw new ErroRegraNegocioHttp(`Informe uma URL de imagem válida para a questão ${numero}.`);
    }
    if (imagem_url && !["http:", "https:"].includes(new URL(imagem_url).protocol)) {
      throw new ErroRegraNegocioHttp(
        `Use uma URL HTTP ou HTTPS para a imagem da questão ${numero}.`,
      );
    }
    if (questao.idTema == null && questao.tema == null && arquivo.idTemaPadrao == null) {
      throw new ErroRegraNegocioHttp(`Informe o tema ${campo}.`);
    }
    const explicacao = texto(questao.explicacao ?? "", `a explicação ${campo}`, 24000, true);
    return {
      numero,
      idTema:
        questao.idTema != null || (questao.tema == null && arquivo.idTemaPadrao != null)
          ? uuid(questao.idTema ?? arquivo.idTemaPadrao, `o tema ${campo}`)
          : null,
      tema:
        questao.idTema == null && questao.tema != null
          ? texto(questao.tema, `o nome do tema ${campo}`, 200)
          : null,
      enunciado: texto(questao.enunciado, `o enunciado ${campo}`, 24000),
      dificuldade,
      fonte: texto(questao.fonte ?? "", `a fonte ${campo}`, 500, true),
      imagem_url,
      explicacao,
      alternativas,
      gabarito: {
        idAlternativaCorreta,
        status: statusGabarito,
        explicacao,
        fonte:
          questao.fonteGabarito == null
            ? null
            : texto(questao.fonteGabarito, `a fonte do gabarito ${campo}`, 500),
      },
    };
  });
  return {
    p_idprova: idProva,
    p_prova: prova,
    p_questoes: questoes,
    p_aplicar: requisicao.aplicar,
  };
}

export async function importarProva(
  repositorio: RepositorioConsultasNegocio,
  lerCorpo: () => Promise<unknown>,
) {
  await new ServicoAutorizacaoUsuarioAutenticado(repositorio).exigirAdministradorAtivo();
  const parametros = prepararImportacaoProva(await lerCorpo());
  const resultado = await repositorio.executarFuncaoPostgreSql<{
    idProva: string | null;
    novaOrganizadora: string | null;
    novosTemas: string[];
  }>("importar_prova_json", parametros);
  const contagem = { definitivo: 0, provisorio: 0, anulada: 0, pendente: 0 };
  for (const { gabarito } of parametros.p_questoes) {
    contagem[gabarito.status as keyof typeof contagem]++;
  }
  return criarRespostaSucesso(
    { ...resultado, quantidade: parametros.p_questoes.length, gabaritos: contagem },
    parametros.p_aplicar ? "Prova importada como rascunho." : "Arquivo validado.",
  );
}
