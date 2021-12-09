import { Prisma } from "@prisma/client";
import _ from "lodash";
import { z } from "zod";

import { checkPremiumUsername } from "@ee/lib/core/checkPremiumUsername";

import { checkRegularUsername } from "@lib/core/checkRegularUsername";
import { ALL_INTEGRATIONS } from "@lib/integrations/getIntegrations";
import slugify from "@lib/slugify";

import { TRPCError } from "@trpc/server";

import { createProtectedRouter, createRouter } from "@server/createRouter";
import { resizeBase64Image } from "@server/lib/resizeBase64Image";
import { resolve } from "path/posix";
//import { webhookRouter } from "@server/routers/viewer/webhook";

const checkUsername =
  process.env.NEXT_PUBLIC_APP_URL === "https://cal.com" ? checkPremiumUsername : checkRegularUsername;

// things that unauthenticated users can query about themselves
const publicViewerRouter = createRouter()
  .query("session", {
    resolve({ ctx }) {
      return ctx.session;
    },
  })
  .query("i18n", {
    async resolve({ ctx }) {
      const { locale, i18n } = ctx;
      return {
        i18n,
        locale,
      };
    },
  });

// routes only available to authenticated users
const loggedInViewerRouter = createProtectedRouter()
  .query("me", {
    resolve({ ctx }) {
      const {
        // pick only the part we want to expose in the API
        id,
        name,
        username,
        email,
        startTime,
        endTime,
        bufferTime,
        locale,
        avatar,
        createdDate,
        completedOnboarding,
        twoFactorEnabled,
        brandColor,
      } = ctx.user;
      const me = {
        id,
        name,
        username,
        email,
        startTime,
        endTime,
        bufferTime,
        locale,
        avatar,
        createdDate,
        completedOnboarding,
        twoFactorEnabled,
        brandColor,
      };
      return me;
    },
  })

  .query("forms", {
    async resolve({ctx}) {
      const { prisma } = ctx;
      const formSelect = Prisma.validator<Prisma.FormSelect>()({
        id: true,
        title: true,
        slug: true,
        description: true,
        position: true,
        url: true,
        status: true,
        hasCustomDomain: true,
        formName: true
      })

      const user = await prisma.user.findUnique({
        where: {
          id: ctx.user.id,
        },
        select:{
          id: true,
          username: true,
          name: true,
          avatar: true,
          plan : true,
          forms:{
            select: formSelect,
            orderBy:[
              {
                position: "desc"
              },
              {
                id: "asc"
              }
            ]
          }
        }
      });
      //console.log(user);

      
      if (!user) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }

      type FormGroup = {
        profile: {
          name: string,
        },
        metadata: {
          formCount: number,
        },
        forms: (typeof user.forms[number] & {$disabled?: boolean})[];
      }

      let formGroups: FormGroup[] = [];

      let customDomainForms = user.forms.filter(form => form.hasCustomDomain === true);
      let subDomainForms = user.forms.filter(form => form.hasCustomDomain === false);

      //Free plan custom domain site limit
      const customDomainMergedForms = customDomainForms.map((form,index) => ({
        ...form,
        $disabled: user.plan === "FREE" && index > 0,
      }))

      //Free plan sub domain site limit
      const subDomainMergedForms = subDomainForms.map((form,index) => ({
        ...form,
        $disabled: user.plan === "FREE" && index > 0,
      }))

      formGroups.push({
        profile: {
         name:"Custom Domain Websites" 
        },
        metadata: {
          formCount: customDomainForms.length
        },
        forms:_.orderBy(customDomainMergedForms, ["position", "id"], ["desc", "asc"])
      })

      formGroups.push({
        profile: {
          name:"Sub Domain Websites"
         },
         metadata: {
           formCount: subDomainForms.length
         },
         forms:_.orderBy(subDomainMergedForms, ["position", "id"], ["desc", "asc"])
      })


      //For adding new websites
      const canAddForms = user.plan !== "FREE" || user.forms.length < 2;

      //console.log(user, canAddEvents);
      return {
        viewer: {
          canAddForms,
          plan : user.plan,
          totalFormCount : user.forms.length
        },
        formGroups: formGroups,
        profiles: formGroups.map(group =>({
          ...group.profile,
          ...group.metadata
        }))
      }
    }
  })
  
  .query("integrations", {
    async resolve({ ctx }) {
      const { user } = ctx;
      const { credentials } = user;

      function countActive(items: { credentialIds: unknown[] }[]) {
        return items.reduce((acc, item) => acc + item.credentialIds.length, 0);
      }
      const integrations = ALL_INTEGRATIONS.map((integration) => ({
        ...integration,
        credentialIds: credentials
          .filter((credential) => credential.type === integration.type)
          .map((credential) => credential.id),
      }));
      // `flatMap()` these work like `.filter()` but infers the types correctly
      const conferencing = integrations.flatMap((item) => (item.variant === "conferencing" ? [item] : []));
      const payment = integrations.flatMap((item) => (item.variant === "payment" ? [item] : []));
      const calendar = integrations.flatMap((item) => (item.variant === "calendar" ? [item] : []));

      return {
        conferencing: {
          items: conferencing,
          numActive: countActive(conferencing),
        },
        calendar: {
          items: calendar,
          numActive: countActive(calendar),
        },
        payment: {
          items: payment,
          numActive: countActive(payment),
        },
      };
    },
  })

  .mutation("updateProfile", {
    input: z.object({
      username: z.string().optional(),
      name: z.string().optional(),
      bio: z.string().optional(),
      avatar: z.string().optional(),
      timeZone: z.string().optional(),
      weekStart: z.string().optional(),
      hideBranding: z.boolean().optional(),
      brandColor: z.string().optional(),
      theme: z.string().optional().nullable(),
      completedOnboarding: z.boolean().optional(),
      locale: z.string().optional(),
    }),
    async resolve({ input, ctx }) {
      const { user, prisma } = ctx;
      const data: Prisma.UserUpdateInput = {
        ...input,
      };
      if (input.username) {
        const username = slugify(input.username);
        // Only validate if we're changing usernames
        if (username !== user.username) {
          data.username = username;
          const response = await checkUsername(username);
          if (!response.available) {
            throw new TRPCError({ code: "BAD_REQUEST", message: response.message });
          }
        }
      }
      if (input.avatar) {
        data.avatar = await resizeBase64Image(input.avatar);
      }

      await prisma.user.update({
        where: {
          id: user.id,
        },
        data,
      });
    },
  })

  .mutation("formOrder", {
    input: z.object({
      ids: z.array(z.number()),
    }),
    async resolve({ input, ctx }) {
      const { prisma, user } = ctx;
      const allForms = await ctx.prisma.form.findMany({
        select: {
          id: true,
        },
        where: {
          id: {
            in: input.ids,
          },
          OR: [
            {
              userId: user.id,
            },
          ],
        },
      });
      const allFormIds = new Set(allForms.map((form) => form.id));
      if (input.ids.some((id) => !allFormIds.has(id))) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
        });
      }
      await Promise.all(
        _.reverse(input.ids).map((id, position) => {
          return prisma.form.update({
            where: {
              id,
            },
            data: {
              position,
            },
          });
        })
      );
    },
  })



export const viewerRouter = createRouter()
  .merge(publicViewerRouter)
  .merge(loggedInViewerRouter)
  //.merge("webhook.", webhookRouter);
