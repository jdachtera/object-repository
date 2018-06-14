import { DateProperty } from "./DateProperty";
import { FloatProperty } from "./FloatProperty";
import { IntegerProperty } from "./IntegerProperty";
import { JSONDataProperty } from "./JSONDataProperty";
import { RelationToManyProperty } from "./RelationToManyProperty";
import { RelationToOneProperty } from "./RelationToOneProperty";
import { TextProperty } from "./TextProperty";

export const text = ({ length } = {}) => new TextProperty({ length });

export const date = ({ autoUpdate } = {}) => new DateProperty({ autoUpdate });

export const float = () => new FloatProperty();

export const integer = () => new IntegerProperty();

export const jsonData = ({ preStringify, postParse } = {}) =>
  new JSONDataProperty({ preStringify, postParse });

export const relationToMany = ({ remoteProperty, repository, lazy } = {}) =>
  new RelationToManyProperty({
    remoteProperty,
    repository,
    lazy
  });

export const relationToOne = ({ remoteProperty, repository, lazy } = {}) =>
  new RelationToOneProperty({
    remoteProperty,
    repository,
    lazy
  });

export default {
  text,
  date,
  float,
  integer,
  jsonData,
  relationToMany,
  relationToOne
};
